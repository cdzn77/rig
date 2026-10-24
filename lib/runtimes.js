// Local LLM runtime adapters. Each adapter answers: is it running, what models
// are installed, which are loaded, and (where the runtime allows it) load/unload.
//
//   LM Studio  : `lms` CLI for inventory + load/unload, REST API as fallback
//   Ollama     : native REST API (keep_alive drives load/unload)
//   OpenAI-ish : mlx_lm.server, llama.cpp server, anything with /v1/models
//                (monitor + benchmark only; these serve one model per process)

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();

async function getJson(url, { timeout = 1500, method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function exec(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Some CLI versions print a banner before the JSON payload.
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* skip */ } }
  }
  return total;
}

function quantFromName(name) {
  const m = String(name).match(/(\d+)[-_ ]?bit|\b(Q\d[_A-Z0-9]*)\b|\b(fp16|bf16|f16)\b/i);
  if (!m) return null;
  return m[1] ? `${m[1]}-bit` : (m[2] || m[3]).toUpperCase();
}

function formatFromPath(p) {
  if (/mlx/i.test(p)) return 'MLX';
  if (/\.gguf$/i.test(p) || /gguf/i.test(p)) return 'GGUF';
  return null;
}

// `lms ls` reports MLX models as format "safetensors" (the file type).
// The engine is what matters to the user, so prefer MLX/GGUF when we can tell.
function formatOf(m) {
  const fromPath = formatFromPath(m.path || '');
  if (fromPath) return fromPath;
  const f = String(m.format || '').toLowerCase();
  if (f === 'gguf') return 'GGUF';
  if (f === 'mlx') return 'MLX';
  return f ? f.toUpperCase() : null;
}

// `lms ls` reports quantization as { name: "4bit" | "Q4_K_M", bits: 4 }.
function quantLabel(q) {
  if (!q) return null;
  if (typeof q === 'string') return q;
  if (q.name && /^\d+\s*-?bit$/i.test(q.name) && q.bits) return `${q.bits}-bit`;
  return q.name || (q.bits ? `${q.bits}-bit` : null);
}

// ============================================================ LM Studio
class LMStudio {
  constructor(cfg = {}) {
    this.id = 'lmstudio';
    this.label = 'LM Studio';
    this.port = cfg.port || 1234;
    this.base = `http://127.0.0.1:${this.port}`;
    this.modelsDir = cfg.modelsDir || path.join(HOME, '.lmstudio', 'models');
    this.bin = cfg.lmsBin || this.findBin();
    this.sizeCache = new Map();
  }

  findBin() {
    if (process.env.LMS_BIN) return process.env.LMS_BIN;
    const p = path.join(HOME, '.lmstudio', 'bin', 'lms');
    return fs.existsSync(p) ? p : 'lms';
  }

  // Inventory straight from disk: publisher/model folders. Always works,
  // even when LM Studio is closed, and gives honest on-disk sizes.
  scanDisk() {
    const out = [];
    let pubs = [];
    try { pubs = fs.readdirSync(this.modelsDir, { withFileTypes: true }); } catch { return out; }
    for (const pub of pubs) {
      if (!pub.isDirectory() || pub.name.startsWith('.')) continue;
      let models = [];
      try { models = fs.readdirSync(path.join(this.modelsDir, pub.name), { withFileTypes: true }); } catch { continue; }
      for (const m of models) {
        if (!m.isDirectory() || m.name.startsWith('.')) continue;
        const full = path.join(this.modelsDir, pub.name, m.name);
        if (!this.sizeCache.has(full)) this.sizeCache.set(full, dirSize(full));
        out.push({ publisher: pub.name, folder: m.name, relPath: `${pub.name}/${m.name}`, sizeBytes: this.sizeCache.get(full) });
      }
    }
    return out;
  }

  async status() {
    const online = !!(await getJson(`${this.base}/v1/models`));
    const disk = this.scanDisk();

    // Preferred: the CLI knows model keys and loaded instances.
    const [ls, ps] = await Promise.all([
      exec(this.bin, ['ls', '--json']),
      online ? exec(this.bin, ['ps', '--json']) : Promise.resolve({ ok: false }),
    ]);
    const lsJson = ls.ok ? parseJsonLoose(ls.stdout) : null;
    const psJson = ps.ok ? parseJsonLoose(ps.stdout) : null;
    const cli = Array.isArray(lsJson);

    // REST fallback for loaded state when the CLI is unavailable.
    const rest = online && !Array.isArray(psJson) ? await getJson(`${this.base}/api/v0/models`) : null;

    const loadedList = Array.isArray(psJson)
      ? psJson
      : (rest?.data || []).filter((m) => m.state === 'loaded');

    const matchDisk = (p) => {
      if (!p) return null;
      const norm = String(p).toLowerCase();
      return disk.find((d) => norm.includes(d.relPath.toLowerCase()) || norm.includes(d.folder.toLowerCase())) || null;
    };

    const models = [];
    if (cli) {
      for (const m of lsJson) {
        if (m.type && m.type !== 'llm' && m.type !== 'vlm') continue; // skip embeddings
        const key = m.modelKey || m.path;
        const d = matchDisk(m.path || key);
        const instances = loadedList.filter((l) => (l.modelKey || l.path) === key || (l.path && l.path === m.path));
        models.push(this.shape({
          key,
          name: m.displayName || key,
          publisher: m.publisher || d?.publisher,
          format: formatOf(m),
          quant: quantLabel(m.quantization),
          params: m.paramsString || null,
          vision: !!m.vision,
          tools: !!m.trainedForToolUse,
          arch: m.architecture || null,
          sizeBytes: m.sizeBytes || d?.sizeBytes || null,
          maxContext: m.maxContextLength || null,
          instances,
          source: m.path,
        }));
      }
    } else {
      for (const d of disk) {
        const restRow = (rest?.data || []).find((r) => matchDisk(r.id)?.relPath === d.relPath || r.id.toLowerCase() === d.folder.toLowerCase());
        const instances = loadedList.filter((l) => (l.id || l.identifier) === restRow?.id);
        models.push(this.shape({
          key: restRow?.id || d.relPath,
          name: d.folder,
          publisher: d.publisher,
          format: (restRow?.compatibility_type || formatFromPath(d.folder) || '').toUpperCase() || null,
          quant: restRow?.quantization || null,
          arch: restRow?.arch || null,
          sizeBytes: d.sizeBytes,
          maxContext: restRow?.max_context_length || null,
          instances,
          source: d.relPath,
        }));
      }
    }

    return {
      id: this.id,
      label: this.label,
      endpoint: this.base,
      online,
      control: cli ? 'cli' : 'none',
      note: cli ? null : 'lms CLI not found, so load and unload are off. Run `~/.lmstudio/bin/lms bootstrap` to enable them.',
      models,
    };
  }

  shape({ key, name, publisher, format, quant, params, arch, sizeBytes, maxContext, instances, source, vision = false, tools = false }) {
    const loaded = instances.length > 0;
    return {
      runtime: this.id,
      key,
      name,
      publisher: publisher || null,
      format,
      quant: quant || quantFromName(source || name),
      params,
      arch,
      vision,
      tools,
      sizeBytes: sizeBytes || null,
      maxContext,
      loaded,
      instanceIds: instances.map((i) => i.identifier || i.id).filter(Boolean),
      contextLength: instances[0]?.contextLength || instances[0]?.loaded_context_length || null,
      // The OpenAI-compatible model id used for chat calls.
      apiId: instances[0]?.identifier || instances[0]?.id || key,
    };
  }

  async load(key, { contextLength } = {}) {
    const args = ['load', key, '-y'];
    if (contextLength) args.push('--context-length', String(contextLength));
    const r = await exec(this.bin, args, 240000);
    if (!r.ok) throw new Error(cleanErr(r) || 'lms load failed');
    return true;
  }

  async unload(key, instanceIds = []) {
    const ids = instanceIds.length ? instanceIds : [key];
    for (const id of ids) {
      const r = await exec(this.bin, ['unload', id], 30000);
      if (!r.ok) throw new Error(cleanErr(r) || 'lms unload failed');
    }
    return true;
  }
}

// ============================================================ Ollama
class Ollama {
  constructor(cfg = {}) {
    this.id = 'ollama';
    this.label = 'Ollama';
    this.port = cfg.port || 11434;
    this.base = `http://127.0.0.1:${this.port}`;
  }

  async status() {
    const version = await getJson(`${this.base}/api/version`);
    if (!version) return { id: this.id, label: this.label, endpoint: this.base, online: false, control: 'api', models: [] };
    const [tags, ps] = await Promise.all([getJson(`${this.base}/api/tags`), getJson(`${this.base}/api/ps`)]);
    const running = ps?.models || [];
    const models = (tags?.models || []).map((m) => {
      const r = running.find((x) => x.name === m.name || x.model === m.model);
      return {
        runtime: this.id,
        key: m.name,
        name: m.name,
        publisher: null,
        format: (m.details?.format || 'gguf').toUpperCase(),
        quant: m.details?.quantization_level || null,
        params: m.details?.parameter_size || null,
        arch: m.details?.family || null,
        sizeBytes: m.size || null,
        maxContext: null,
        loaded: !!r,
        loadedBytes: r?.size || null,
        instanceIds: r ? [m.name] : [],
        contextLength: r?.context_length || null,
        expiresAt: r?.expires_at || null,
        apiId: m.name,
      };
    });
    return { id: this.id, label: this.label, endpoint: this.base, online: true, version: version.version, control: 'api', models };
  }

  async load(key) {
    const r = await getJson(`${this.base}/api/generate`, { method: 'POST', body: { model: key, keep_alive: '30m' }, timeout: 240000 });
    if (!r) throw new Error('Ollama did not load the model');
    return true;
  }

  async unload(key) {
    const r = await getJson(`${this.base}/api/generate`, { method: 'POST', body: { model: key, keep_alive: 0 }, timeout: 30000 });
    if (!r) throw new Error('Ollama did not unload the model');
    return true;
  }
}

// ============================================================ Generic OpenAI-compatible server
class OpenAIServer {
  constructor(port) {
    this.port = port;
    this.id = `openai-${port}`;
    this.base = `http://127.0.0.1:${port}`;
    this.label = `Server :${port}`;
  }

  async status() {
    const list = await getJson(`${this.base}/v1/models`);
    if (!list) return { id: this.id, label: this.label, endpoint: this.base, online: false, control: 'none', models: [], hidden: true };
    const props = await getJson(`${this.base}/props`);
    const label = props ? `llama.cpp :${this.port}` : `MLX / OpenAI :${this.port}`;
    const models = (list.data || []).map((m) => ({
      runtime: this.id,
      key: m.id,
      name: path.basename(m.id),
      publisher: null,
      format: props ? 'GGUF' : formatFromPath(m.id),
      quant: quantFromName(m.id),
      params: null,
      arch: null,
      sizeBytes: null,
      maxContext: props?.default_generation_settings?.n_ctx || null,
      loaded: true,
      instanceIds: [m.id],
      contextLength: props?.default_generation_settings?.n_ctx || null,
      apiId: m.id,
    }));
    return {
      id: this.id,
      label,
      endpoint: this.base,
      online: true,
      control: 'none',
      note: 'This server holds one model per process. Start or stop it from the terminal.',
      models,
    };
  }
}

function cleanErr(r) {
  return (r.stderr || r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-3).join(' ');
}

function createRuntimes(cfg = {}) {
  const list = [new LMStudio(cfg.lmstudio), new Ollama(cfg.ollama)];
  for (const port of cfg.openaiPorts || [8080, 8000]) list.push(new OpenAIServer(port));
  return list;
}

module.exports = { createRuntimes, getJson, quantFromName };
