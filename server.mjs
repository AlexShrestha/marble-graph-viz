/**
 * marble-graph-viz — minimal 3D KG viewer + chat.
 *
 * Serves a local marble knowledge graph (JSON file produced by marble's
 * `Marble.save()`) as a force-directed graph on http://localhost:9120/3d,
 * with a chat panel that grounds Claude / opencode / claude-cli in the
 * KG context.
 *
 * Endpoints:
 *   GET  /                   redirect → /3d
 *   GET  /3d                 the viewer (public/3d.html)
 *   GET  /api/graph          { nodes, links } from the KG
 *   POST /api/chat           { message } → { reply } (Claude / claude-cli / opencode with KG context)
 *   GET  /api/node/:id       detail for one node (full fact + history)
 *   POST /api/curate         manual curator run
 *   POST /api/curate-revert  undo a curator run by id
 *   GET  /api/curator-runs   audit log + autonomous-loop status
 *
 * Env:
 *   MARBLE_KG_PATH                 path to your marble KG JSON file
 *                                  (required — set this to wherever Marble.save() wrote)
 *   MARBLE_CORE_PATH               path to a marble checkout; defaults to ~/Documents/GitHub/marble
 *                                  (must include the Curator API — marble 0.2+ / PR #55)
 *   PORT                           override the port (default 9120)
 *   ANTHROPIC_API_KEY              optional: chat uses Anthropic SDK if set, else falls
 *                                  through to claude CLI, then opencode CLI, then stub
 *   MARBLE_CHAT_BACKEND            'auto' | 'sdk' | 'claude-cli' | 'opencode' (default 'auto')
 *   MARBLE_CHAT_MODEL              default 'claude-sonnet-4-5'
 *   MARBLE_CHAT_MAX_NODES          how many KG nodes to inline as chat context (default 80)
 *   MARBLE_CURATE_INTERVAL_MS      autonomous curator cadence (default 120000 = 2 min)
 *   MARBLE_CURATE_LIMIT            facts per curator cycle (default 8)
 *   MARBLE_CURATE_START_DELAY_MS   grace period at boot (default 15000)
 *   OPENCODE_BIN                   path to opencode binary (default ~/.opencode/bin/opencode)
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = parseInt(process.env.PORT ?? '9120', 10);
const KG_PATH = process.env.MARBLE_KG_PATH
  ?? path.join(os.homedir(), 'Documents/GitHub/marble/data/kg/user-kg.json');
const CHAT_MODEL = process.env.MARBLE_CHAT_MODEL ?? 'claude-sonnet-4-5';
const CHAT_MAX_NODES = parseInt(process.env.MARBLE_CHAT_MAX_NODES ?? '80', 10);

// Path to the marble checkout with the Curator API (marble 0.2+ / PR #55).
const MARBLE_PATH = process.env.MARBLE_CORE_PATH
  ?? path.join(os.homedir(), 'Documents/GitHub/marble');

// Auto-curate loop: server runs marble.curate() on this interval, no button
// clicks needed. Each cycle: backup → 12 suspects → opencode-deepseek-flash-
// free → 4-decision classify → write back. Decisions stream to clients via
// polling /api/curator-runs.
const AUTO_CURATE_INTERVAL_MS = parseInt(process.env.MARBLE_CURATE_INTERVAL_MS ?? '120000', 10);  // 2 min
const AUTO_CURATE_LIMIT = parseInt(process.env.MARBLE_CURATE_LIMIT ?? '8', 10);
const AUTO_CURATE_START_DELAY_MS = parseInt(process.env.MARBLE_CURATE_START_DELAY_MS ?? '15000', 10);

let autoCurateStatus = { state: 'idle', nextRunAt: 0, lastRunId: null, lastError: null };

// ─── Load KG ───────────────────────────────────────────────────────────────

if (!existsSync(KG_PATH)) {
  console.error(`[marble-graph-viz] KG file not found: ${KG_PATH}`);
  console.error('Set MARBLE_KG_PATH to point at your marble-kg.json');
  process.exit(1);
}

let kgData = null;
let kgLoadedAt = 0;

async function loadKg() {
  const raw = await readFile(KG_PATH, 'utf-8');
  kgData = JSON.parse(raw);
  kgLoadedAt = Date.now();
  const u = kgData.user || {};
  console.log(`[marble-graph-viz] loaded KG: ${u.beliefs?.length ?? 0}b / ${u.preferences?.length ?? 0}p / ${u.identities?.length ?? 0}i / ${u.syntheses?.length ?? 0}s / ${u.episodes?.length ?? 0}e`);
}

await loadKg();

// ─── Graph builder ─────────────────────────────────────────────────────────

/**
 * Build { nodes, links } for 3d-force-graph from the KG.
 *
 * Nodes:
 *   - one per active belief / preference / identity
 *   - one per synthesis
 * Links:
 *   - synthesis → each reinforcing_node (kind: 'reinforces')
 *   - synthesis → each contradicting_node (kind: 'contradicts')
 *   - implicit cross-fact links via shared topic (cheap visual connectivity)
 */
function buildGraph(kg) {
  const u = kg.user || {};
  const nodes = [];
  const nodeById = new Map();

  const addNode = (n) => {
    if (nodeById.has(n.id)) return;
    nodeById.set(n.id, n);
    nodes.push(n);
  };

  // L1 facts (beliefs/preferences/identities)
  for (const b of u.beliefs || []) {
    if (b.valid_to) continue;
    addNode({
      id: `belief:${b.topic}`,
      label: b.topic,
      group: 'belief',
      layer: 'L1',
      subject: b.subject || 'self',
      strength: b.strength ?? 0.5,
      claim: b.claim,
      evidence_count: b.evidence_count ?? 1,
      challenge: b._meta?.challenge_candidate === true,
      val: 1 + (b.strength ?? 0.5) * 4,
    });
  }
  for (const p of u.preferences || []) {
    if (p.valid_to) continue;
    addNode({
      id: `preference:${p.type}`,
      label: p.type,
      group: 'preference',
      layer: 'L1',
      subject: p.subject || 'self',
      strength: p.strength ?? 0.5,
      description: p.description,
      challenge: p._meta?.challenge_candidate === true,
      val: 1 + Math.abs(p.strength ?? 0.5) * 4,
    });
  }
  for (const i of u.identities || []) {
    if (i.valid_to) continue;
    addNode({
      id: `identity:${i.role}`,
      label: i.role,
      group: 'identity',
      layer: 'L1',
      subject: i.subject || 'self',
      strength: i.salience ?? 0.7,
      context: i.context,
      challenge: i._meta?.challenge_candidate === true,
      val: 1 + (i.salience ?? 0.7) * 4,
    });
  }

  const links = [];

  // L1.5 insights (insight-swarm output)
  for (let ix = 0; ix < (u.insights?.length ?? 0); ix++) {
    const ins = u.insights[ix];
    const iid = `insight:${ins.id ?? ix}`;
    addNode({
      id: iid,
      label: ins.insight ? ins.insight.slice(0, 60) : (ins.lens || `insight_${ix}`),
      group: 'insight',
      layer: 'L1.5',
      lens: ins.lens,
      strength: ins.confidence ?? 0.5,
      insight_text: ins.insight,
      question: ins.question,
      val: 1.5 + (ins.confidence ?? 0.5) * 4,
    });
    for (const ref of ins.supporting_facts || []) {
      if (nodeById.has(ref)) {
        links.push({ source: iid, target: ref, kind: 'supports', strength: 0.4 });
      }
    }
  }

  // L2 syntheses
  for (let si = 0; si < (u.syntheses?.length ?? 0); si++) {
    const s = u.syntheses[si];
    const sid = `synthesis:${s.id ?? si}`;
    addNode({
      id: sid,
      label: s.label || s.trait?.dimension || `synth_${si}`,
      group: 'synthesis',
      layer: 'L2',
      origin: s.origin,
      confidence: s.confidence,
      strength: s.confidence ?? 0.5,
      mechanics: s.mechanics,
      val: 2 + (s.confidence ?? 0.5) * 6,
    });

    for (const ref of s.reinforcing_nodes || []) {
      if (nodeById.has(ref)) {
        links.push({ source: sid, target: ref, kind: 'reinforces', strength: s.confidence ?? 0.5 });
      }
    }
    for (const ref of s.contradicting_nodes || []) {
      if (nodeById.has(ref)) {
        links.push({ source: sid, target: ref, kind: 'contradicts', strength: s.confidence ?? 0.5 });
      }
    }
  }

  // L3 clones (archetype hypotheses)
  for (const c of u.clones || []) {
    if (c.status && c.status !== 'active') continue;
    addNode({
      id: `clone:${c.id}`,
      label: (c.hypothesis || c.id || '').slice(0, 60),
      group: 'clone',
      layer: 'L3',
      strength: c.confidence ?? 0.5,
      gap: c.gap,
      hypothesis: c.hypothesis,
      is_cold_start: c._meta?.source?.is_cold_start === true,
      val: 3 + (c.confidence ?? 0.5) * 8,
    });
  }

  // L0 episodes — capped so they don't drown everything else
  const episodes = (u.episodes || []).slice(-200); // most recent 200
  for (const ep of episodes) {
    addNode({
      id: `episode:${ep.id}`,
      label: (ep.content_summary || ep.id || '').slice(0, 40) || ep.source,
      group: 'episode',
      layer: 'L0',
      source: ep.source,
      source_date: ep.source_date,
      strength: 0.3,
      val: 0.8,
    });
  }

  // Implicit topic links — same first token of topic → light link so the L1
  // graph doesn't shatter into islands. Skip if shared topic would create
  // > N links from one node (visual hairball protection).
  const TOPIC_LINK_CAP = 6;
  const byTopicHead = new Map();
  for (const n of nodes) {
    if (n.group === 'synthesis') continue;
    const head = (n.label || '').toLowerCase().split(/[\s_:/-]/)[0];
    if (!head || head.length < 3) continue;
    if (!byTopicHead.has(head)) byTopicHead.set(head, []);
    byTopicHead.get(head).push(n.id);
  }
  for (const [, ids] of byTopicHead) {
    if (ids.length < 2 || ids.length > 8) continue; // skip noise + huge clusters
    for (let i = 0; i < ids.length - 1 && i < TOPIC_LINK_CAP; i++) {
      links.push({ source: ids[i], target: ids[i + 1], kind: 'topic', strength: 0.2 });
    }
  }

  return { nodes, links };
}

// ─── HTTP app ──────────────────────────────────────────────────────────────

const app = new Hono();

app.get('/', (c) => c.redirect('/3d'));

app.get('/3d', async (c) => {
  const html = await readFile(path.join(import.meta.dirname, 'public', '3d.html'), 'utf-8');
  return c.html(html);
});

app.get('/api/graph', (c) => {
  const g = buildGraph(kgData);
  return c.json({
    nodes: g.nodes,
    links: g.links,
    stats: {
      beliefs: kgData.user?.beliefs?.filter(b => !b.valid_to).length ?? 0,
      preferences: kgData.user?.preferences?.filter(p => !p.valid_to).length ?? 0,
      identities: kgData.user?.identities?.filter(i => !i.valid_to).length ?? 0,
      syntheses: kgData.user?.syntheses?.length ?? 0,
      kg_loaded_at: new Date(kgLoadedAt).toISOString(),
    },
  });
});

app.get('/api/node/:id', (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const [type, ...rest] = id.split(':');
  const key = rest.join(':');
  const u = kgData.user || {};

  let fact = null;
  if (type === 'belief') {
    fact = (u.beliefs || []).find(b => b.topic === key && !b.valid_to);
  } else if (type === 'preference') {
    fact = (u.preferences || []).find(p => p.type === key && !p.valid_to);
  } else if (type === 'identity') {
    fact = (u.identities || []).find(i => i.role === key && !i.valid_to);
  } else if (type === 'synthesis') {
    fact = (u.syntheses || []).find(s => String(s.id) === key);
  }
  if (!fact) return c.json({ error: 'not found', id }, 404);
  return c.json({ id, type, fact });
});

app.post('/api/chat', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad json' }, 400); }
  const message = String(body?.message ?? '').trim();
  if (!message) return c.json({ error: 'message required' }, 400);

  const ctx = topNFactsContext(kgData, CHAT_MAX_NODES);
  const system = `You are helping the user reason about their own knowledge graph (KG), the canonical record of their beliefs, preferences, and identities derived from their chat history and other sources. Answer their question using ONLY the facts below as ground truth. If the KG doesn't contain enough information to answer, say so plainly — don't make up facts.

KG snapshot:
${ctx}`;
  const fullPrompt = `${system}\n\nUser question: ${message}`;

  // Backend order:
  //   1. ANTHROPIC_API_KEY → SDK call (cleanest)
  //   2. `claude -p` CLI    → uses the user's logged-in Claude session
  //   3. `opencode run`     → free model fallback (any model the user has configured)
  //   4. Stub               → echo top facts
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const backend = (body?.backend || process.env.MARBLE_CHAT_BACKEND || 'auto').toLowerCase();

  // 1. SDK path
  if ((backend === 'auto' || backend === 'sdk') && apiKey) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model: CHAT_MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: message }],
      });
      return c.json({ reply: resp.content?.[0]?.text ?? '(no response)', backend: 'sdk' });
    } catch (err) {
      console.warn('[chat] SDK failed, falling through:', err?.message);
    }
  }

  // 2. claude CLI path — pipe full prompt via stdin in --print mode
  if (backend === 'auto' || backend === 'claude-cli') {
    const out = await runCli('claude', ['-p', '--output-format', 'text'], fullPrompt, 60_000);
    if (out.ok) return c.json({ reply: out.stdout.trim() || '(empty)', backend: 'claude-cli' });
    if (backend === 'claude-cli') return c.json({ error: 'claude CLI failed', stderr: out.stderr }, 500);
    console.warn('[chat] claude-cli failed:', out.stderr?.slice(0, 200));
  }

  // 3. opencode CLI path
  if (backend === 'auto' || backend === 'opencode') {
    const out = await runCli('opencode', ['run', '--quiet'], fullPrompt, 60_000);
    if (out.ok) return c.json({ reply: out.stdout.trim() || '(empty)', backend: 'opencode' });
    if (backend === 'opencode') return c.json({ error: 'opencode failed', stderr: out.stderr }, 500);
    console.warn('[chat] opencode failed:', out.stderr?.slice(0, 200));
  }

  // 4. Stub
  return c.json({
    reply: '(no chat backend available — install `claude` or `opencode`, or set ANTHROPIC_API_KEY. Stub: top 3 self-facts below.)\n\n'
      + topNFactsContext(kgData, 3),
    backend: 'stub',
  });
});

import { spawn } from 'node:child_process';
function runCli(cmd, args, stdin, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      // stdin: 'ignore' so the child doesn't block reading from /dev/tty
      // when we have no input to give. Many TUI-style CLIs (opencode included)
      // hang forever if stdin is a pipe that never closes.
      const stdio = stdin
        ? ['pipe', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe'];
      proc = spawn(cmd, args, { stdio });
    } catch (err) {
      return resolve({ ok: false, stdout: '', stderr: `spawn failed: ${err?.message}` });
    }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', err => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr + ' ' + err.message }); });
    proc.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }); });
    if (stdin && proc.stdin) { proc.stdin.write(stdin); proc.stdin.end(); }
  });
}

function topNFactsContext(kg, n) {
  const u = kg.user || {};
  const lines = [];
  const score = (f) => (f.strength ?? f.salience ?? 0) * ((f.subject ?? 'self') === 'self' ? 1 : 0.3);
  const pool = [
    ...(u.beliefs || []).filter(b => !b.valid_to).map(b => ({ kind: 'belief', topic: b.topic, value: b.claim, ...b })),
    ...(u.preferences || []).filter(p => !p.valid_to).map(p => ({ kind: 'preference', topic: p.type, value: p.description, ...p })),
    ...(u.identities || []).filter(i => !i.valid_to).map(i => ({ kind: 'identity', topic: i.role, value: i.context, salience: i.salience, ...i })),
  ];
  pool.sort((a, b) => score(b) - score(a));
  for (const f of pool.slice(0, n)) {
    lines.push(`- [${f.kind}] ${f.topic}: ${f.value} (strength=${(f.strength ?? f.salience ?? 0).toFixed(2)}, subject=${f.subject ?? 'self'})`);
  }
  return lines.join('\n');
}

// ─── Curator preview (real LLM decisions, no KG mutation) ──────────────────
//
// Mirrors marble's Curator (PR 2): pick suspect facts via cheap heuristics,
// classify each as confirm | unclear | ambiguous | skip via LLM, return
// decisions to the client for animation.
//
// Read-only — does NOT write back to the KG file. The real curator endpoint
// (POST /api/curate) handles the write path.

const THIRD_PARTY_FLAG_WORDS = [
  'gift', 'gifts', 'girlfriend', 'boyfriend', 'spouse', 'partner', 'wife', 'husband',
  'kid', 'kids', 'child', 'children', 'son', 'daughter',
  'mom', 'dad', 'mother', 'father', 'parent', 'parents',
  'sister', 'brother', 'sibling', 'friend', 'friends',
  'colleague', 'colleagues', 'coworker', 'coworkers',
  'client', 'clients', 'boss', 'employee',
  'on behalf of', 'researching for', 'someone i know', 'someone else',
];

function selectSuspects(kg, limit = 15) {
  const u = kg.user || {};
  const suspects = [];
  const consider = (collection, kind, getText) => {
    for (const fact of u[collection] || []) {
      if (fact.valid_to) continue;
      if (fact.subject === 'other') continue;
      const strength = typeof fact.strength === 'number' ? fact.strength
        : typeof fact.salience === 'number' ? fact.salience : 1.0;
      const text = String(getText(fact) || '').toLowerCase();
      const reasons = [];
      if (strength < 0.7) reasons.push('low_strength');
      if ((fact.evidence_count ?? 1) <= 1) reasons.push('single_evidence');
      if (text && THIRD_PARTY_FLAG_WORDS.some(w => text.includes(w))) reasons.push('third_party_word');
      if (reasons.length === 0) continue;
      suspects.push({ kind, ref: `${kind}:${fact.topic || fact.type || fact.role}`, fact, reasons, strength });
    }
  };
  consider('beliefs',     'belief',     f => f.claim);
  consider('preferences', 'preference', f => f.description);
  consider('identities',  'identity',   f => `${f.role} ${f.context || ''}`);
  // Rank: more reasons = more suspect; tie-break by lower strength.
  suspects.sort((a, b) => (b.reasons.length - a.reasons.length) || (a.strength - b.strength));
  return suspects.slice(0, limit);
}

function buildInterrogationPrompt(suspects) {
  const lines = suspects.map((s, i) => {
    const f = s.fact;
    const text = s.kind === 'identity' ? `${f.role}${f.context ? ` (${f.context})` : ''}` :
      (f.claim || f.description || f.value || '(no description)');
    const strength = typeof f.strength === 'number' ? f.strength.toFixed(2) :
                     typeof f.salience === 'number' ? f.salience.toFixed(2) : '?';
    const subject = f.subject || 'self';
    const evidence = f.evidence_count ?? 1;
    return `${i + 1}. [${s.kind}] ${text} | strength=${strength} | subject=${subject} | evidence_count=${evidence} | suspect_reasons=${s.reasons.join(',')}`;
  });

  return `You are a careful auditor reviewing facts in a user's knowledge graph (KG). Your job is NOT to delete facts. Classify each fact into ONE of four decisions:

- "confirm"   — clearly about the user themselves; evidence holds up
- "unclear"   — about the user but doubtful (generic, aspirational, weakly supported)
- "ambiguous" — subject is uncertain (could be user OR someone in their life — gift recipient, friend, kid, etc.)
- "skip"      — insufficient signal to decide; leave alone, retry later

NEVER return "retire" or "delete". When unsure, prefer "unclear" or "skip".

Facts under review:
${lines.join('\n')}

Return ONLY a JSON array, one object per fact (matched by id):
[{"id": 1, "decision": "confirm|unclear|ambiguous|skip", "reason": "<1 sentence>"}, ...]

JSON array only — no prose, no markdown fences.`;
}

function parseDecisions(text) {
  const s = String(text || '').trim();
  // Try direct parse
  try { const v = JSON.parse(s); if (Array.isArray(v)) return v; } catch {}
  // Fenced
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) { try { const v = JSON.parse(fence[1].trim()); if (Array.isArray(v)) return v; } catch {} }
  // Bare array
  const a = s.indexOf('['), e = s.lastIndexOf(']');
  if (a !== -1 && e > a) { try { const v = JSON.parse(s.slice(a, e + 1)); if (Array.isArray(v)) return v; } catch {} }
  return null;
}

async function callOpencode(prompt, model = 'opencode/deepseek-v4-flash-free', timeoutMs = 180_000) {
  const bin = process.env.OPENCODE_BIN || `${os.homedir()}/.opencode/bin/opencode`;
  const args = ['run', '-m', model, '--format', 'json', '--pure', '--dir', '/tmp', prompt];
  console.log(`[opencode] spawning ${bin} (prompt=${prompt.length} chars, model=${model})`);
  const t0 = Date.now();
  const out = await runCli(bin, args, null, timeoutMs);
  console.log(`[opencode] returned in ${Date.now() - t0}ms ok=${out.ok} stdout=${out.stdout?.length} stderr=${out.stderr?.length}`);
  if (!out.ok && out.stderr) console.log(`[opencode] stderr: ${out.stderr.slice(0, 500)}`);
  if (!out.ok) return { ok: false, error: out.stderr || `exit ${out.code}` };
  const texts = [];
  for (const line of String(out.stdout).split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === 'text' && ev.part?.text) texts.push(ev.part.text);
    } catch {}
  }
  return { ok: true, text: texts.join('') };
}

app.post('/api/curate-preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(20, parseInt(body.limit ?? '12', 10)));
  const model = body.model || 'opencode/deepseek-v4-flash-free';

  const suspects = selectSuspects(kgData, limit);
  if (suspects.length === 0) {
    return c.json({ suspects: [], decisions: [], reason: 'no suspects', model });
  }

  const prompt = buildInterrogationPrompt(suspects);
  const t0 = Date.now();
  const out = await callOpencode(prompt, model);
  const elapsedMs = Date.now() - t0;
  if (!out.ok) return c.json({ error: 'opencode failed', stderr: out.error?.slice(0, 500), elapsedMs }, 500);

  const decisions = parseDecisions(out.text);
  if (!Array.isArray(decisions)) {
    return c.json({ error: 'parse failed', raw: out.text?.slice(0, 500), elapsedMs }, 500);
  }

  // Attach each decision back to its suspect's node_id so the client can animate
  const result = [];
  for (let i = 0; i < suspects.length; i++) {
    const s = suspects[i];
    const d = decisions.find(x => Number(x.id) === i + 1) || { decision: 'skip', reason: 'no decision returned' };
    const decType = String(d.decision || '').toLowerCase().trim();
    const valid = ['confirm', 'unclear', 'ambiguous', 'skip'].includes(decType) ? decType : 'skip';
    result.push({
      node_id: s.ref,            // matches graph node ids (belief:topic / preference:type / identity:role)
      label: s.kind === 'identity' ? s.fact.role : (s.fact.topic || s.fact.type),
      kind: s.kind,
      strength: s.strength,
      reasons: s.reasons,
      decision: valid,
      reason: d.reason || '',
      raw_decision: decType,     // for debugging if LLM tried to retire
    });
  }
  const counts = result.reduce((acc, r) => { acc[r.decision] = (acc[r.decision] || 0) + 1; return acc; }, {});
  return c.json({ suspects: result.length, decisions: result, counts, elapsedMs, model });
});

// ─── Real curator (writes to the KG file) ──────────────────────────────────
//
// Uses marble's Curator class (introduced in marble PR #55). Wraps the free
// opencode model as an LLM function. Auto-backs up the KG file before each
// run so any bad LLM decision is recoverable via POST /api/curate-revert.
//
// State after a successful run:
//   - The KG file is mutated on disk (strength bumps / lowering, gap-beliefs,
//     _meta.history entries with run_id)
//   - In-memory `kgData` is reloaded so subsequent /api/graph reflects changes
//   - A `CuratorRun` record is appended to kg.user.curatorRuns

let marbleInstance = null;
let curateLock = false;          // simple in-process mutex

async function getMarble() {
  if (marbleInstance) return marbleInstance;
  const indexUrl = `file://${path.join(MARBLE_PATH, 'core/index.js')}`;
  const { Marble } = await import(indexUrl);
  // LLM function: pipe through opencode CLI with the free deepseek model.
  // The Curator class wraps this via wrapUserLLM, then withBudget.
  const llmFn = async (prompt) => {
    const out = await callOpencode(prompt);
    if (!out.ok) throw new Error(`opencode failed: ${out.error?.slice(0, 200) || 'unknown'}`);
    return out.text || '';
  };
  marbleInstance = new Marble({ storage: KG_PATH, llm: llmFn, silent: true });
  await marbleInstance.init();
  return marbleInstance;
}

async function backupKg() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.dirname(KG_PATH);
  const base = path.basename(KG_PATH, '.json');
  const dest = path.join(dir, `${base}.backup-${stamp}.json`);
  await copyFile(KG_PATH, dest);
  return dest;
}

app.post('/api/curate', async (c) => {
  if (curateLock) return c.json({ error: 'curate already in progress' }, 409);
  curateLock = true;
  try {
    const body = await c.req.json().catch(() => ({}));
    const limit = Math.max(1, Math.min(20, parseInt(body.limit ?? '12', 10)));

    const backup = await backupKg();
    console.log(`[curate] backup: ${backup}`);

    const marble = await getMarble();
    const t0 = Date.now();
    const run = await marble.curate({ limit });
    const elapsedMs = Date.now() - t0;
    console.log(`[curate] run ${run.id}: examined=${run.examined} confirmed=${run.confirmed} unclear=${run.unclear} ambiguous=${run.ambiguous} skipped=${run.skipped} in ${elapsedMs}ms`);

    // Reload in-memory KG so /api/graph reflects the new strengths / gaps
    await loadKg();

    // Project decisions onto graph node ids for client animation
    const decisions = (run.decisions || []).map(d => ({
      node_id: d.ref,            // ref format matches our graph ids
      decision: d.decision,
      reason: d.reason || '',
    }));
    const counts = {
      confirm: run.confirmed,
      unclear: run.unclear,
      ambiguous: run.ambiguous,
      skip: run.skipped,
    };
    return c.json({
      run_id: run.id,
      examined: run.examined,
      counts,
      decisions,
      backup,
      elapsedMs,
    });
  } catch (err) {
    console.error('[curate] failed:', err?.message);
    return c.json({ error: 'curate failed', message: err?.message || String(err) }, 500);
  } finally {
    curateLock = false;
  }
});

app.post('/api/curate-revert', async (c) => {
  if (curateLock) return c.json({ error: 'curate in progress, wait' }, 409);
  curateLock = true;
  try {
    const body = await c.req.json().catch(() => ({}));
    const runId = String(body.run_id ?? '').trim();
    if (!runId) return c.json({ error: 'run_id required' }, 400);

    const marble = await getMarble();
    const result = await marble.curateRevert(runId);
    await loadKg();
    console.log(`[curate-revert] run ${runId}: reverted=${result.reverted} gapsFlagged=${result.gapBeliefsFlagged}`);
    return c.json({ run_id: runId, ...result });
  } catch (err) {
    return c.json({ error: 'revert failed', message: err?.message || String(err) }, 500);
  } finally {
    curateLock = false;
  }
});

// List recent curator runs + auto-curate status (client polls this every 5s)
app.get('/api/curator-runs', (c) => {
  const runs = (kgData.user?.curatorRuns || []).slice(-20).reverse();
  return c.json({
    runs,
    auto: {
      ...autoCurateStatus,
      intervalMs: AUTO_CURATE_INTERVAL_MS,
      limit: AUTO_CURATE_LIMIT,
      msUntilNext: Math.max(0, autoCurateStatus.nextRunAt - Date.now()),
    },
  });
});

// ─── Auto-curate background loop ───────────────────────────────────────────

async function runOneCurateCycle() {
  if (curateLock) return { skipped: true, reason: 'manual curate in progress' };
  curateLock = true;
  autoCurateStatus.state = 'running';
  try {
    const backup = await backupKg();
    const marble = await getMarble();
    const t0 = Date.now();
    const run = await marble.curate({ limit: AUTO_CURATE_LIMIT });
    const elapsedMs = Date.now() - t0;
    await loadKg();
    autoCurateStatus.lastRunId = run.id;
    autoCurateStatus.lastError = null;
    console.log(`[auto-curate] ${run.id.slice(0,8)} examined=${run.examined} confirm=${run.confirmed} unclear=${run.unclear} ambig=${run.ambiguous} skip=${run.skipped} in ${elapsedMs}ms`);
    return { run_id: run.id, counts: { confirm: run.confirmed, unclear: run.unclear, ambiguous: run.ambiguous, skip: run.skipped }, elapsedMs, backup };
  } catch (err) {
    autoCurateStatus.lastError = err?.message || String(err);
    console.error('[auto-curate] failed:', autoCurateStatus.lastError);
    return { error: autoCurateStatus.lastError };
  } finally {
    curateLock = false;
    autoCurateStatus.state = 'idle';
    autoCurateStatus.nextRunAt = Date.now() + AUTO_CURATE_INTERVAL_MS;
  }
}

async function autoCurateLoop() {
  // Initial delay so the server is fully warm
  console.log(`[auto-curate] starting in ${AUTO_CURATE_START_DELAY_MS}ms, then every ${AUTO_CURATE_INTERVAL_MS}ms (limit=${AUTO_CURATE_LIMIT})`);
  autoCurateStatus.nextRunAt = Date.now() + AUTO_CURATE_START_DELAY_MS;
  await new Promise(r => setTimeout(r, AUTO_CURATE_START_DELAY_MS));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOneCurateCycle();
    // Sleep until next scheduled run (may be slightly more than interval if
    // the cycle took non-trivial time, since nextRunAt is set in the finally
    // block after the run completes).
    const wait = Math.max(0, autoCurateStatus.nextRunAt - Date.now());
    await new Promise(r => setTimeout(r, wait));
  }
}

// Kick off the autonomous loop (fire and forget)
autoCurateLoop().catch(err => console.error('[auto-curate] loop crashed:', err));

// Stub for `three/webgpu` — the static import in three-render-objects fails
// against esm.sh (404). We never use WebGPU, but the import must resolve.
// Mapped via the HTML's importmap.
app.get('/three-webgpu-stub.js', (c) => {
  return new Response(
    `export class WebGPURenderer { constructor() { throw new Error('WebGPU disabled'); } }
export default {};
`,
    { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } },
  );
});

app.use('/static/*', serveStatic({ root: './public' }));

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });
console.log(`[marble-graph-viz] listening on http://localhost:${PORT}/3d`);
console.log(`[marble-graph-viz] KG: ${KG_PATH}`);
