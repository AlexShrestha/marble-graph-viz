# marble-graph-viz

A minimal 3D viewer + chat + autonomous-curator dashboard for a
[marble](https://github.com/AlexShrestha/marble) knowledge graph.

- Renders your marble KG as a 3D force-directed graph
  ([3d-force-graph](https://github.com/vasturiano/3d-force-graph))
- Runs marble's `Curator` on a loop in the background (no buttons to
  click) — decisions stream into the UI as animated node flashes
- Chat panel grounded in your KG context, with auto-fallback across
  Anthropic SDK → `claude` CLI → `opencode` CLI → stub
- One-click undo of any curator run via `marble.curateRevert(runId)`

Companion project to [marble](https://github.com/AlexShrestha/marble);
marble ships as a library, this is the visualization on top.

## Requirements

- Node 20+ (ESM)
- A marble checkout with the Curator API (marble 0.2+ / PR #55+)
- A marble KG JSON file (produced by `marble.save()` or the
  `marble` CLI)
- One LLM backend, in priority order — first one that works wins:
  - `ANTHROPIC_API_KEY` in the env → Anthropic SDK
  - [Claude CLI](https://claude.ai/code) (`claude` on `$PATH`) → uses
    your Claude Code subscription
  - [opencode](https://opencode.ai) (`opencode` on `$PATH` or
    `OPENCODE_BIN`) → free, runs locally with
    `opencode/deepseek-v4-flash-free` by default
  - None of the above → chat returns a stub; the curator loop will
    fail-and-retry (no destructive writes; the LLM only ever bumps or
    lowers strength values)

## Install

```bash
git clone https://github.com/AlexShrestha/marble-graph-viz.git
cd marble-graph-viz
npm install
```

## Run

```bash
export MARBLE_KG_PATH=/path/to/your/user-kg.json    # where Marble.save() wrote
export MARBLE_CORE_PATH=/path/to/marble             # marble checkout with Curator
npm start
```

```
→ marble-graph-viz listening on http://localhost:9120
→ open http://localhost:9120/3d
```

For development:

```bash
npm run dev    # node --watch — restarts on edit
```

## Environment

| Var | Default | Purpose |
|---|---|---|
| `MARBLE_KG_PATH` | `~/Documents/GitHub/marble/data/kg/user-kg.json` | Your KG file |
| `MARBLE_CORE_PATH` | `~/Documents/GitHub/marble` | A marble checkout (needs Curator API) |
| `PORT` | `9120` | HTTP port |
| `ANTHROPIC_API_KEY` | — | If set, chat uses Anthropic SDK |
| `MARBLE_CHAT_BACKEND` | `auto` | `auto` / `sdk` / `claude-cli` / `opencode` |
| `MARBLE_CHAT_MODEL` | `claude-sonnet-4-5` | Model for the SDK path |
| `MARBLE_CHAT_MAX_NODES` | `80` | KG nodes inlined as chat context |
| `MARBLE_CURATE_INTERVAL_MS` | `120000` | Time between autonomous curator passes |
| `MARBLE_CURATE_LIMIT` | `8` | Facts examined per pass |
| `MARBLE_CURATE_START_DELAY_MS` | `15000` | Grace period at boot before the first pass |
| `OPENCODE_BIN` | `~/.opencode/bin/opencode` | Override the opencode binary path |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | redirect → `/3d` |
| `GET` | `/3d` | the viewer (`public/3d.html`) |
| `GET` | `/api/graph` | `{ nodes, links }` derived from the KG |
| `GET` | `/api/node/:id` | one node's full record + provenance |
| `POST` | `/api/chat` | `{ message }` → streamed reply (KG-grounded) |
| `POST` | `/api/curate` | manual `marble.curate({ limit })` |
| `POST` | `/api/curate-revert` | `marble.curateRevert(runId)` |
| `GET` | `/api/curator-runs` | audit log + autonomous-loop status |

## What the autonomous curator does

Every `MARBLE_CURATE_INTERVAL_MS` (default 2 minutes) the server:

1. Selects `MARBLE_CURATE_LIMIT` suspect facts from the KG
   (low-strength, single-evidence, third-party heuristics — same logic
   as marble's `Curator.selectSuspects`)
2. Backs up the KG file (`.backups/<timestamp>.json` next to the KG)
3. Calls the LLM to classify each as one of four decisions:
   - `confirm` — bump strength + evidence_count
   - `unclear` — keep but lower strength, flag as challenge candidate
   - `ambiguous` — lower strength, write a `gap:<topic>` belief
   - `skip` — leave alone
4. Writes back. Appends a `CuratorRun` to `kg.user.curatorRuns`
5. Animates the affected nodes in the UI

**The curator never deletes.** Marble's mechanical reconciliation
owns the `valid_to` retirement path; the LLM-driven curator only
adjusts strengths and adds gap-beliefs. Bad runs are recoverable via
`POST /api/curate-revert` with the `run_id`.

In-process mutex prevents concurrent runs (autonomous loop + manual
`POST /api/curate` can't race).

## Auto-start at login (macOS, launchd)

Create `~/Library/LaunchAgents/com.YOU.marble-graph-viz.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.YOU.marble-graph-viz</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@20/bin/node</string>
    <string>/Users/YOU/path/to/marble-graph-viz/server.mjs</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/YOU/path/to/marble-graph-viz</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/Users/YOU/Library/Logs/marble-graph-viz.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/Library/Logs/marble-graph-viz.err.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOU/.opencode/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MARBLE_KG_PATH</key>
    <string>/Users/YOU/path/to/user-kg.json</string>
    <key>MARBLE_CORE_PATH</key>
    <string>/Users/YOU/Documents/GitHub/marble</string>
    <key>MARBLE_CURATE_INTERVAL_MS</key>
    <string>120000</string>
    <key>MARBLE_CURATE_LIMIT</key>
    <string>8</string>
  </dict>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.YOU.marble-graph-viz.plist
launchctl list | grep marble                # confirm running
tail -f ~/Library/Logs/marble-graph-viz.log
```

Adjust the node path if you're not using `/opt/homebrew/opt/node@20`.

## Auto-start at boot (Linux, systemd)

```ini
# /etc/systemd/system/marble-graph-viz.service
[Unit]
Description=Marble Graph Visualization
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/YOU/marble-graph-viz
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=10
Environment="MARBLE_KG_PATH=/home/YOU/user-kg.json"
Environment="MARBLE_CORE_PATH=/home/YOU/marble"
Environment="MARBLE_CURATE_INTERVAL_MS=120000"
Environment="MARBLE_CURATE_LIMIT=8"
User=YOU

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now marble-graph-viz
sudo systemctl status marble-graph-viz
```

## Architecture notes

- Single-file Hono server (~600 lines) + single-page `public/3d.html`
  (~700 lines) — no build step
- `public/3d.html` uses an ESM import map to share one Three.js
  instance with the `3d-force-graph` lib. Multiple THREE copies cause
  silent render failures
- `?deps=three-render-objects@1.40.0` pins below the version that
  requires `Timer` from `three` (esm.sh doesn't ship that export)
- For 5K+ node KGs, the default lib sphere/cylinder primitives draw
  much faster than per-node `nodeThreeObject` custom meshes
- The force layout spreads nodes across ±2000 units; camera starts at
  `z=2200` so it sits outside the cloud

## See also

- [marble](https://github.com/AlexShrestha/marble) — the underlying
  personalization engine
- [marble's `docs/graph-visualization.md`](https://github.com/AlexShrestha/marble/blob/main/docs/graph-visualization.md)
  — building your own viz on top of marble's KG
- [marble's `docs/llm-providers.md`](https://github.com/AlexShrestha/marble/blob/main/docs/llm-providers.md)
  — the LLM backends this server talks to

## License

MIT
