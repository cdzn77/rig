// Hardware and memory metrics for Apple Silicon Macs.
// Works with zero installs (sysctl, vm_stat, pmset). If `macmon` is on PATH,
// it adds GPU utilisation, power and temperatures without needing sudo.

const { execFile, spawn } = require('node:child_process');
const os = require('node:os');

const IS_MAC = process.platform === 'darwin';

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function sysctl(name) {
  const out = await run('sysctl', ['-n', name]);
  return out == null ? null : out.trim();
}

// ---------- static info (read once) ----------
let staticInfo = null;
async function getStatic() {
  if (staticInfo) return staticInfo;
  const totalBytes = os.totalmem();
  const chip = (await sysctl('machdep.cpu.brand_string')) || os.cpus()[0]?.model || 'Unknown';
  const wiredLimitMb = Number(await sysctl('iogpu.wired_limit_mb')) || 0;
  const pCores = Number(await sysctl('hw.perflevel0.logicalcpu')) || null;
  const eCores = Number(await sysctl('hw.perflevel1.logicalcpu')) || null;
  staticInfo = {
    chip,
    hostname: os.hostname(),
    totalBytes,
    cores: os.cpus().length,
    pCores,
    eCores,
    wiredLimitMb,
  };
  return staticInfo;
}

// macOS lets the GPU wire roughly 75% of RAM on machines above 36 GB and
// about two thirds below that, unless iogpu.wired_limit_mb overrides it.
function gpuBudgetBytes(info) {
  if (info.wiredLimitMb > 0) return info.wiredLimitMb * 1024 * 1024;
  const gb = info.totalBytes / 1024 ** 3;
  return Math.floor(info.totalBytes * (gb > 36 ? 0.75 : 0.67));
}

// ---------- memory ----------
function parseVmStat(text) {
  if (!text) return null;
  const pageSize = Number((text.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const get = (label) => {
    const m = text.match(new RegExp(label + ':\\s+(\\d+)'));
    return m ? Number(m[1]) * pageSize : 0;
  };
  const wired = get('Pages wired down');
  const active = get('Pages active');
  const compressed = get('Pages occupied by compressor');
  const inactive = get('Pages inactive');
  const free = get('Pages free');
  return { wired, active, compressed, inactive, free, used: wired + active + compressed };
}

function parseSwap(text) {
  // "total = 2048.00M  used = 512.25M  free = 1535.75M  (encrypted)"
  if (!text) return null;
  const toBytes = (v, unit) => Number(v) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[unit] || 1);
  const pick = (key) => {
    const m = text.match(new RegExp(key + '\\s*=\\s*([\\d.]+)([KMG])'));
    return m ? toBytes(m[1], m[2]) : 0;
  };
  return { total: pick('total'), used: pick('used') };
}

const PRESSURE = { 1: 'normal', 2: 'warning', 4: 'critical' };

async function getMemory() {
  const info = await getStatic();
  const [vm, swapText, level, avail] = await Promise.all([
    run('vm_stat', []),
    sysctl('vm.swapusage'),
    sysctl('kern.memorystatus_vm_pressure_level'),
    sysctl('kern.memorystatus_level'),
  ]);
  const v = parseVmStat(vm);
  const swap = parseSwap(swapText) || { total: 0, used: 0 };
  return {
    totalBytes: info.totalBytes,
    usedBytes: v ? v.used : info.totalBytes - os.freemem(),
    wiredBytes: v ? v.wired : null,
    compressedBytes: v ? v.compressed : null,
    swapUsedBytes: swap.used,
    swapTotalBytes: swap.total,
    pressure: PRESSURE[Number(level)] || (IS_MAC ? 'unknown' : 'unavailable'),
    availablePct: avail != null ? Number(avail) : null,
    gpuBudgetBytes: gpuBudgetBytes(info),
  };
}

// ---------- CPU (fallback when macmon is missing) ----------
let lastCpu = null;
function getCpuPct() {
  const now = os.cpus().map((c) => c.times);
  let pct = null;
  if (lastCpu) {
    let idle = 0, total = 0;
    now.forEach((t, i) => {
      const p = lastCpu[i];
      const dt = Object.keys(t).reduce((s, k) => s + (t[k] - p[k]), 0);
      total += dt;
      idle += t.idle - p.idle;
    });
    pct = total > 0 ? Math.round((1 - idle / total) * 100) : null;
  }
  lastCpu = now;
  return pct;
}

// ---------- thermal ----------
let thermalCache = { at: 0, value: { state: 'unknown', cpuSpeedLimit: null } };
async function getThermal() {
  if (Date.now() - thermalCache.at < 10000) return thermalCache.value;
  const out = await run('pmset', ['-g', 'therm']);
  let value = { state: IS_MAC ? 'nominal' : 'unavailable', cpuSpeedLimit: null };
  if (out) {
    const limit = out.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
    if (limit) value.cpuSpeedLimit = Number(limit[1]);
    const warn = out.match(/thermal warning level set to (\d+)/i);
    if ((warn && Number(warn[1]) > 0) || (value.cpuSpeedLimit != null && value.cpuSpeedLimit < 100)) {
      value.state = 'throttling';
    }
  }
  thermalCache = { at: Date.now(), value };
  return value;
}

// ---------- macmon (optional) ----------
const macmon = { available: false, last: null, error: null, child: null };

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// macmon reports usage as [freqMHz, ratio 0..1]. Be defensive about shape.
function usagePct(v) {
  if (Array.isArray(v)) return num(v[1]) != null ? Math.round(v[1] * 100) : null;
  if (num(v) != null) return Math.round(v <= 1 ? v * 100 : v);
  return null;
}

function normaliseMacmon(j) {
  const temp = j.temp || {};
  return {
    // Active ratio matches Activity Monitor's "busy" reading. The usage pair is
    // scaled by clock speed, so it reads near zero whenever the GPU idles low.
    gpuPct: num(j.gpu_active_ratio) != null ? Math.round(j.gpu_active_ratio * 100) : usagePct(j.gpu_usage),
    cpuPct: num(j.cpu_active_ratio) != null ? Math.round(j.cpu_active_ratio * 100) : null,
    fans: Array.isArray(j.fans) ? j.fans.map((f) => ({ rpm: num(f.rpm), max: num(f.max_rpm) })) : [],
    pCpuPct: usagePct(j.pcpu_usage),
    eCpuPct: usagePct(j.ecpu_usage),
    gpuWatts: num(j.gpu_power),
    cpuWatts: num(j.cpu_power),
    aneWatts: num(j.ane_power),
    sysWatts: num(j.sys_power) ?? num(j.all_power),
    gpuTempC: num(temp.gpu_temp_avg),
    cpuTempC: num(temp.cpu_temp_avg),
  };
}

// Finder-launched processes can have a short PATH, so check Homebrew's
// folders directly before falling back to whatever PATH finds.
function findMacmon() {
  if (process.env.MACMON_BIN) return process.env.MACMON_BIN;
  const fs = require('node:fs');
  for (const p of ['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon']) {
    if (fs.existsSync(p)) return p;
  }
  return 'macmon';
}

let macmonRetry = null;
function scheduleMacmonRetry() {
  if (macmonRetry) return;
  // Retry once a minute, so installing macmon while Rig runs needs no restart.
  macmonRetry = setTimeout(() => { macmonRetry = null; startMacmon(); }, 60000);
  macmonRetry.unref();
}

function startMacmon() {
  if (!IS_MAC && !process.env.MACMON_BIN) return;
  const bin = findMacmon();
  let child;
  try {
    child = spawn(bin, ['pipe', '-i', '1000'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    macmon.error = String(e.message);
    scheduleMacmonRetry();
    return;
  }
  macmon.child = child;
  child.on('error', (e) => {
    macmon.available = false;
    macmon.error = e.code === 'ENOENT' ? 'not-installed' : String(e.message);
    scheduleMacmonRetry();
  });
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        macmon.last = normaliseMacmon(JSON.parse(line));
        macmon.available = true;
        macmon.error = null;
      } catch { /* partial line, ignore */ }
    }
  });
  child.on('exit', () => {
    macmon.available = false;
    scheduleMacmonRetry();
  });
}

// ---------- apps holding memory (read-only) ----------
// RSS overcounts memory shared between processes, so treat this as a ranking,
// not exact figures. Helper processes are grouped under their parent app.
let appsCache = { at: 0, value: [] };
async function getTopApps() {
  if (Date.now() - appsCache.at < 10000) return appsCache.value;
  const out = await run('ps', ['-axo', 'rss=,comm=']);
  if (!out) return appsCache.value;
  const groups = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const app = m[2].match(/\/([^/]+)\.app(?:\/|$)/);
    const name = app ? app[1] : m[2].split('/').pop();
    const g = groups.get(name) || { name, bytes: 0, procs: 0 };
    g.bytes += Number(m[1]) * 1024;
    g.procs++;
    groups.set(name, g);
  }
  const value = [...groups.values()]
    .filter((g) => g.bytes > 200 * 1024 ** 2)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8);
  appsCache = { at: Date.now(), value };
  return value;
}

async function getHardware() {
  const [info, memory, thermal, topApps] = await Promise.all([getStatic(), getMemory(), getThermal(), getTopApps()]);
  const cpuPct = getCpuPct();
  return {
    info,
    memory,
    thermal,
    cpuPct: macmon.available && macmon.last && macmon.last.cpuPct != null
      ? macmon.last.cpuPct
      : macmon.available && macmon.last
      ? Math.round(((macmon.last.pCpuPct ?? 0) * (info.pCores || 1) + (macmon.last.eCpuPct ?? 0) * (info.eCores || 0)) / ((info.pCores || 1) + (info.eCores || 0)))
      : cpuPct,
    topApps,
    macmon: macmon.available ? macmon.last : null,
    macmonStatus: macmon.available ? 'ok' : (macmon.error || 'starting'),
  };
}

function stopMacmon() {
  if (macmonRetry) { clearTimeout(macmonRetry); macmonRetry = null; }
  if (macmon.child) { try { macmon.child.kill(); } catch { /* already gone */ } }
}

module.exports = { getHardware, getStatic, startMacmon, stopMacmon, parseVmStat, parseSwap, gpuBudgetBytes };
