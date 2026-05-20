# Architecture

This is a small project — one server file, one HTML page, an autonomous
loop, and a KG on disk. The interesting bits are the *gotchas* that
took real work to figure out, not the structure. This page documents
those so you don't re-debug them.

## Data flow

```
┌──────────────────────────┐
│  marble (library, Node)  │  ── writes ──▶  user-kg.json   (your KG)
└──────────────────────────┘                       │
                                                   │
        ┌──────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ server.mjs (this repo, Hono on :9120)                     │
│                                                           │
│   ┌─── autonomous curator loop ────────────────────────┐  │
│   │ every MARBLE_CURATE_INTERVAL_MS:                   │  │
│   │   1. backup KG to .backups/<ts>.json               │  │
│   │   2. marble.curate({ limit })                      │  │
│   │   3. reload kgData in-memory                       │  │
│   │   4. append CuratorRun to kg.user.curatorRuns      │  │
│   └────────────────────────────────────────────────────┘  │
│                                                           │
│   GET  /api/graph         → { nodes, links }              │
│   GET  /api/node/:id      → one node + provenance         │
│   GET  /api/curator-runs  → audit log + loop status       │
│   POST /api/chat          → LLM with KG context           │
│   POST /api/curate        → manual run (same mutex)       │
│   POST /api/curate-revert → marble.curateRevert(id)       │
└───────────────────────────────────────────────────────────┘
        │                                          ▲
        │ HTML + JSON                              │ polls
        ▼                                          │
┌──────────────────────────────────────────────────┴────────┐
│ public/3d.html (single page, ESM, no build step)          │
│                                                           │
│   - 3d-force-graph renders KG (nodes color = layer)       │
│   - layer toggles (beliefs / preferences / identities …)  │
│   - polls /api/curator-runs every few seconds; animates   │
│     each new decision as a flash on the affected node     │
│   - chat panel → POST /api/chat                           │
│   - revert button → POST /api/curate-revert               │
└───────────────────────────────────────────────────────────┘
```

## Mutex

The autonomous loop and `POST /api/curate` share one in-process boolean
(`curateLock` in server.mjs). Both write to the same KG file, and
marble's `Curator` doesn't have its own locking — overlapping runs
would step on each other's `_meta.history` writes. The boolean is
sufficient because the server is single-process; if you ever shard
across multiple servers, you'll need a file-lock instead.

## Why the chat fallback chain

`/api/chat` tries backends in priority order — Anthropic SDK → `claude`
CLI → `opencode` CLI → stub. Reasoning:

1. **Anthropic SDK** is fastest and most reliable when the API key is
   available. Streams tokens cleanly.
2. **`claude` CLI** is the user's logged-in Claude Code subscription. No
   API key, no metering, but slower spawn latency than the SDK.
3. **`opencode` CLI** is free, runs locally, uses
   `opencode/deepseek-v4-flash-free` by default. Slowest of the three
   but works offline-ish.
4. **Stub** echoes the top-N self-facts so the UI still has *some*
   response if everything else fails.

Each backend can be forced via `MARBLE_CHAT_BACKEND={sdk|claude-cli|opencode}`
rather than `auto`. Set it explicitly during development if you're
chasing a backend-specific bug.

## CDN gotchas (`public/3d.html`)

This page took three rounds of dependency-fighting to render. If you
edit it, don't break these:

### 1. Single Three.js instance via import map

```html
<script type="importmap">
{ "imports": {
  "three": "https://esm.sh/three@0.149.0",
  "three/webgpu": "/three-webgpu-stub.js",
  "three/": "https://esm.sh/three@0.149.0/"
} } </script>
```

Without the import map, `3d-force-graph` and any code you write that
imports `three` each pull their own copy. The two copies don't share
WebGL state and the scene silently renders black — no error, just no
output. The map forces *one* THREE.

### 2. Pinning `three-render-objects@1.40.0`

```html
<script type="module">
  import ForceGraph3D from
    'https://esm.sh/3d-force-graph@1.73.4?external=three&deps=three-render-objects@1.40.0';
</script>
```

`three-render-objects@1.41+` imports `Timer` from `three`, which
**esm.sh doesn't ship** as an export. The page throws
`SyntaxError: The requested module 'three' does not provide an export
named 'Timer'`. Pinning the lib's `three-render-objects` dep to 1.40 is
the only way around it without self-hosting Three.js.

### 3. WebGPU stub

`three-render-objects` also imports `three/webgpu`. esm.sh returns
404 for that path on the version we use. The import map's
`"three/webgpu": "/three-webgpu-stub.js"` entry routes that import to a
local stub the server.mjs serves — an empty class so the import
resolves without errors. None of the actual WebGPU code paths are hit
in our 2D-ish render, so the empty stub is fine.

## opencode invocation

Three flags + one stdio choice keep this working:

```javascript
spawn(opencodeBin, [
  'run',
  '-m', 'opencode/deepseek-v4-flash-free',
  '--format', 'json',
  '--pure',
  '--dir', '/tmp',
  prompt,
], { stdio: ['ignore', 'pipe', 'pipe'] });
```

- **`--pure`** — without this, opencode auto-loads the nearest project
  as context (`marble`'s 200K-token codebase, in our case), bloating
  every prompt by 10–20K tokens.
- **`--dir /tmp`** — pins the CWD to a neutral location so opencode
  doesn't read whatever files are next to the spawned process.
- **`--format json`** — line-delimited events instead of the formatted
  default. Each line that parses as JSON and has `type: 'text'` gets
  its `part.text` concatenated into the response.
- **`stdio: ['ignore', 'pipe', 'pipe']`** — closes stdin. TUI-style
  CLIs (opencode included) hang forever on a pipe stdin that nobody
  writes to.

## Render tips (for the 1000–10000 node range)

The KG this was tested against has ~7000 nodes after a full rebuild
(beliefs + preferences + identities + syntheses + entities + episodes).
Things that worked:

- **Default lib primitives** (sphere/cylinder). Custom
  `nodeThreeObject` (per-node Three groups) crashes Chrome's WebGL
  context past ~3K nodes; the lib's batched primitives draw the whole
  graph in one call.
- **Camera at `z=2200`**. The default force-layout spreads nodes
  across roughly ±2000 units. Anything closer than ~2100 starts
  *inside* the cloud and you see nothing.
- **Throttle the curator-runs poll**. Every 3–5 seconds is enough;
  more frequent polls re-fetch the audit log without giving you any
  new state.
- **Emissive pulse on decision** rather than particle paths between
  nodes. Particles at this node count tank framerate; per-node
  `material.emissive` tweens read better and cost nothing.

## File sizes

- `server.mjs` — ~730 lines
- `public/3d.html` — ~1060 lines (HTML + CSS + a single inline ESM script)
- `package.json` — 14 lines, 3 runtime deps

If `server.mjs` grows past ~1000 lines, split out the curator loop and
the chat backend chain into separate files. Below that threshold the
single-file shape is easier to read.

## See also

- [marble](https://github.com/AlexShrestha/marble) — the library this
  visualizes
- [marble docs/graph-visualization.md](https://github.com/AlexShrestha/marble/blob/main/docs/graph-visualization.md)
  — how marble docs reference this companion project
- [marble docs/llm-providers.md](https://github.com/AlexShrestha/marble/blob/main/docs/llm-providers.md)
  — the opencode / claude-cli / Anthropic backends this server delegates to
