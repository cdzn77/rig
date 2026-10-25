#!/usr/bin/env node
// Rig: a local dashboard for running LLMs on an Apple Silicon Mac.
// Zero dependencies. Listens on 127.0.0.1 only.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const mac = require('./lib/mac');
const { createRuntimes } = require('./lib/runtimes');
const bench = require('./lib/bench');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const config = Object.assign(
  { port: 4545, lmstudio: { port: 1234 }, ollama: { port: 11434 }, openaiPorts: [8080, 8000], kvOverheadGB: 1.5 },
  readJson(CONFIG_FILE) || {}
);
const PORT = Number(process.env.RIG_PORT || config.port);
const HOST = '127.0.0.1';

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

const runtimes = createRuntimes(config);
mac.startMacmon();

// ---------------------------------------------------------------- state
const HISTORY_MAX = 450; // 15 minutes at 2s
const history = [];
let runtimeState = [];
let runtimeAt = 0;
const pending = new Map(); // "runtime|key" -> 'loading' | 'unloading' | 'benchmarking'
const events = []; // recent action log, newest last

function logEvent(kind, text) {
  events.push({ at: new Date().toISOString(), kind, text });
  if (events.length > 30) events.shift();
}

async function refreshRuntimes(force = false) {
  if (!force && Date.now() - runtimeAt < 5000) return runtimeState;
  const results = await Promise.all(runtimes.map((r) => r.status().catch((e) => ({ id: r.id, label: r.label, online: false, error: e.message, models: [] }))));
  runtimeState = results;
  runtimeAt = Date.now();
  return runtimeState;
}

const GiB = 1024 ** 3;

function computeFit(hw, rts) {
  const budget = hw.memory.gpuBudgetBytes;
  let used = 0;
  for (const rt of rts) for (const m of rt.models) if (m.loaded) used += m.loadedBytes || m.sizeBytes || 0;
  const headroom = Math.max(0, budget - used);
  // Other apps share the same unified memory. Loading past what's actually free
  // forces macOS to compress and swap, which slows everything, models included.
  const reserve = (config.ramReserveGB ?? 3) * GiB;
  const ramFree = Math.max(0, hw.memory.totalBytes - hw.memory.usedBytes - reserve);
  const free = Math.min(headroom, ramFree);
  const overhead = config.kvOverheadGB * GiB;
  const critical = hw.memory.pressure === 'critical';

  for (const rt of rts) {
    for (const m of rt.models) {
      if (m.loaded) { m.fit = 'loaded'; continue; }
      if (!m.sizeBytes) { m.fit = 'unknown'; continue; }
      const need = m.sizeBytes * 1.05 + overhead;
      m.needBytes = Math.round(need);
      m.freeBytes = free;
      if (need > budget) m.fit = 'too-big';
      else if (need > headroom) m.fit = 'unload-first';
      else if (need > ramFree) m.fit = 'close-apps';
      else if (critical || need > headroom * 0.85) m.fit = 'tight';
      else m.fit = 'fits';
    }
  }
  return { budgetBytes: budget, modelBytes: used, headroomBytes: free, gpuHeadroomBytes: headroom, ramFreeBytes: ramFree, overheadBytes: overhead };
}

async function snapshot() {
  const [hw, rts] = await Promise.all([mac.getHardware(), refreshRuntimes()]);
  // Swap that's growing slows generation; a large but flat total is leftover
  // from earlier and harmless. Compare against roughly a minute ago.
  const ref = history.length >= 30 ? history[history.length - 30] : history[0];
  hw.memory.swapDeltaBytes = ref ? hw.memory.swapUsedBytes - ref.swapUsed : 0;
  const visible = rts.filter((r) => !r.hidden);
  const budget = computeFit(hw, visible);
  for (const rt of visible) for (const m of rt.models) m.pending = pending.get(`${rt.id}|${m.key}`) || null;
  return {
    at: Date.now(),
    hardware: hw,
    budget,
    runtimes: visible,
    bench: { running: bench.isRunning(), prompts: Object.fromEntries(Object.entries(bench.PROMPTS).map(([k, v]) => [k, v.label])) },
    events: events.slice(-10),
  };
}

// Sample every 2 seconds so history keeps filling with no browser open.
let latest = null;
async function tick() {
  try {
    latest = await snapshot();
    const hw = latest.hardware;
    history.push({
      t: latest.at,
      memUsed: hw.memory.usedBytes,
      swapUsed: hw.memory.swapUsedBytes,
      modelBytes: latest.budget.modelBytes,
      cpuPct: hw.cpuPct,
      gpuPct: hw.macmon?.gpuPct ?? null,
      gpuWatts: hw.macmon?.gpuWatts ?? null,
      pressure: hw.memory.pressure,
    });
    if (history.length > HISTORY_MAX) history.shift();
    for (const res of clients) send(res, latest);
  } catch (e) {
    console.error('tick failed:', e.message);
  }
}
setInterval(tick, 2000);
tick();

// ---------------------------------------------------------------- actions
function findModel(runtimeId, key) {
  const rt = runtimes.find((r) => r.id === runtimeId);
  const st = runtimeState.find((r) => r.id === runtimeId);
  const model = st?.models.find((m) => m.key === key);
  return { rt, st, model };
}

async function doAction(kind, body) {
  const { runtime, key } = body || {};
  const { rt, st, model } = findModel(runtime, key);
  if (!rt || !model) throw httpError(404, 'Model not found. Refresh and try again.');
  const id = `${runtime}|${key}`;
  if (pending.has(id)) throw httpError(409, `${model.name} is already ${pending.get(id)}.`);

  if (kind === 'load') {
    if (!rt.load || st.control === 'none') throw httpError(400, `${st.label} can't load models from here.`);
    if (model.fit === 'too-big') throw httpError(400, `${model.name} needs more memory than the GPU can use on this Mac.`);
    pending.set(id, 'loading');
    tick();
    try {
      await rt.load(key, { contextLength: body.contextLength });
      logEvent('ok', `Loaded ${model.name}`);
    } catch (e) {
      logEvent('error', `Couldn't load ${model.name}: ${e.message}`);
      throw httpError(500, e.message);
    } finally {
      pending.delete(id);
      await refreshRuntimes(true);
      tick();
    }
    return { ok: true };
  }

  if (kind === 'unload') {
    if (!rt.unload || st.control === 'none') throw httpError(400, `${st.label} can't unload models from here.`);
    pending.set(id, 'unloading');
    tick();
    try {
      await rt.unload(key, model.instanceIds);
      logEvent('ok', `Unloaded ${model.name}`);
    } catch (e) {
      logEvent('error', `Couldn't unload ${model.name}: ${e.message}`);
      throw httpError(500, e.message);
    } finally {
      pending.delete(id);
      await refreshRuntimes(true);
      tick();
    }
    return { ok: true };
  }

  if (kind === 'bench') {
    if (!model.loaded) throw httpError(400, `Load ${model.name} before benchmarking it, so load time doesn't skew the result.`);
    pending.set(id, 'benchmarking');
    tick();
    try {
      const result = await bench.runBench({
        endpoint: st.endpoint,
        runtimeLabel: st.label,
        model: model.name,
        apiId: model.apiId,
        promptType: body.promptType,
      });
      logEvent('ok', `Benchmarked ${model.name}: ${result.decodeTps} tok/s`);
      return result;
    } catch (e) {
      logEvent('error', `Benchmark failed on ${model.name}: ${e.message}`);
      throw httpError(500, e.message);
    } finally {
      pending.delete(id);
      tick();
    }
  }

  throw httpError(404, 'Unknown action');
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------------------------------------------------------- http
const clients = new Set();
// A visited web page can hold unreadable no-cors streams open until tab close;
// bound registrations so held connections can't exhaust the daemon's fds.
const MAX_STREAM_CLIENTS = 32;
function send(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) { reject(httpError(413, 'Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'Invalid JSON')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // Block DNS-rebinding: only answer requests addressed to localhost.
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('Forbidden host'); }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    fs.readFile(path.join(__dirname, 'public', file), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    return json(res, 200, { ...(latest || (await snapshot())), history });
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    if (clients.size >= MAX_STREAM_CLIENTS) {
      res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'Too many open streams. Close a dashboard tab and retry.' }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    if (latest) send(res, latest);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/bench') {
    return json(res, 200, bench.loadHistory().slice(-50).reverse());
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    // Block cross-site requests from other tabs: same origin + JSON only.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'Cross-origin request blocked' });
    if (!String(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'JSON required' });
    const kind = url.pathname.slice(5);
    try {
      const body = await readBody(req);
      if (kind === 'refresh') { await refreshRuntimes(true); await tick(); return json(res, 200, { ok: true }); }
      const result = await doAction(kind, body);
      return json(res, 200, result);
    } catch (e) {
      return json(res, e.status || 500, { error: e.message });
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Rig is running at http://${HOST}:${PORT}`);
});

// ---------------------------------------------------------------- shutdown
// Close the port and stop macmon on Ctrl+C, on Quit from Rig.app, or when the
// launcher disappears. Nothing is left listening after Rig closes.
let stopping = false;
function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  console.log(`Rig stopping (${reason}).`);
  mac.stopMacmon();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('quit'));
process.on('SIGHUP', () => shutdown('terminal closed'));

const PARENT_PID = Number(process.env.RIG_PARENT_PID || 0);
if (PARENT_PID) {
  setInterval(() => {
    try { process.kill(PARENT_PID, 0); } catch { shutdown('Rig.app closed'); }
  }, 3000);
}
