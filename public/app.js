// Rig dashboard client. Vanilla JS, no build step.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const V = (name) => document.querySelector(`[data-v="${name}"]`);
  const GiB = 1024 ** 3;

  const state = { snap: null, history: [], runtimeSig: '', benchSig: '' };

  // ------------------------------------------------------------ formatting
  const gb = (b, d = 1) => (b == null ? '–' : `${(b / GiB).toFixed(d)} GB`);
  const pct = (n) => (n == null ? '–' : `${Math.round(n)}%`);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeShort = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dateShort = (iso) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? timeShort(iso) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeShort(iso);
  };

  const ICON = {
    ok: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><path d="M8 1.8l6.6 12H1.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.6v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    bad: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    none: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };

  const FIT = {
    loaded: { icon: 'ok', text: 'Loaded' },
    fits: { icon: 'ok', text: 'Fits' },
    tight: { icon: 'warn', text: 'Tight fit' },
    'unload-first': { icon: 'warn', text: 'Unload another first' },
    'close-apps': { icon: 'warn', text: 'Close apps first' },
    'too-big': { icon: 'bad', text: 'Too big for this Mac' },
    unknown: { icon: 'none', text: 'Size unknown' },
  };

  // ------------------------------------------------------------ announcements
  const announcer = $('#announcer');
  function announce(msg) {
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = msg; }, 50);
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
  }

  // ------------------------------------------------------------ tiles
  function setState(el, level) {
    el.classList.remove('state-ok', 'state-warn', 'state-bad');
    if (level) el.classList.add(`state-${level}`);
  }

  function renderTiles(s) {
    const hw = s.hardware;
    const m = hw.memory;
    const info = hw.info;

    $('#machine').textContent = `${info.chip} · ${Math.round(info.totalBytes / GiB)} GB unified memory · ${info.cores} cores`;

    // Pressure
    const pEl = V('pressure');
    const p = m.pressure;
    const pMap = { normal: ['ok', 'Normal'], warning: ['warn', 'Warning'], critical: ['bad', 'Critical'] };
    const [lvl, label] = pMap[p] || [null, p === 'unavailable' ? 'Not on macOS' : 'Unknown'];
    pEl.innerHTML = `${ICON[lvl || 'none']} ${label}`;
    setState(pEl, lvl);
    V('ram').textContent = `${gb(m.usedBytes)} of ${gb(m.totalBytes, 0)} in use`;

    // Model budget
    const b = s.budget;
    const usedPct = b.budgetBytes ? Math.min(100, (b.modelBytes / b.budgetBytes) * 100) : 0;
    const hEl = V('headroom');
    hEl.textContent = `${gb(b.headroomBytes)} free`;
    const ramFreeGB = b.ramFreeBytes / GiB;
    const level = usedPct > 90 || ramFreeGB < 2 ? 'bad' : usedPct > 75 || ramFreeGB < 6 ? 'warn' : null;
    setState(hEl, level);
    const meter = V('budget-meter');
    meter.setAttribute('aria-valuenow', String(Math.round(usedPct)));
    meter.setAttribute('aria-valuetext', `${gb(b.modelBytes)} of ${gb(b.budgetBytes)} used by loaded models`);
    meter.dataset.level = level || '';
    $('.meter-fill', meter).style.width = `${usedPct}%`;
    const limitNote = info.wiredLimitMb > 0 ? 'custom GPU limit' : 'macOS default GPU limit';
    V('budget').textContent = `${gb(b.modelBytes)} loaded of ${gb(b.budgetBytes)} (${limitNote}). Other apps leave ${gb(b.ramFreeBytes)} of RAM free.`;

    // Swap
    const sEl = V('swap');
    const swapGB = m.swapUsedBytes / GiB;
    const growth = m.swapDeltaBytes || 0;
    if (growth > 100 * 1024 ** 2) {
      sEl.innerHTML = `${ICON.warn} ${gb(m.swapUsedBytes)}`;
      setState(sEl, 'bad');
      V('swap-note').textContent = `Growing: up ${gb(growth)} in the last minute. This is what slows generation. Close an app or unload a model.`;
    } else if (swapGB > 1) {
      sEl.textContent = gb(m.swapUsedBytes);
      setState(sEl, null);
      V('swap-note').textContent = 'Left over from earlier and not growing, so it isn’t slowing anything. It clears on restart.';
    } else {
      sEl.textContent = gb(m.swapUsedBytes);
      setState(sEl, 'ok');
      V('swap-note').textContent = 'Healthy. Models are running from RAM.';
    }

    // GPU
    const gEl = V('gpu');
    const mm = hw.macmon;
    if (mm) {
      gEl.textContent = pct(mm.gpuPct);
      const bits = [];
      if (mm.gpuWatts != null) bits.push(`${mm.gpuWatts.toFixed(1)} W`);
      if (mm.gpuTempC != null) bits.push(`${Math.round(mm.gpuTempC)}°C`);
      bits.push(`CPU ${pct(hw.cpuPct)}`);
      V('gpu-note').textContent = bits.join(' · ');
    } else {
      gEl.textContent = '–';
      V('gpu-note').innerHTML = hw.macmonStatus === 'not-installed'
        ? `CPU ${pct(hw.cpuPct)}. For GPU, power and temps: <code>brew install macmon</code>`
        : `CPU ${pct(hw.cpuPct)}. Waiting for GPU readings…`;
    }

    // Thermals
    const tEl = V('thermal');
    const th = hw.thermal;
    if (th.state === 'throttling') {
      tEl.innerHTML = `${ICON.warn} Throttling`;
      setState(tEl, 'warn');
      V('thermal-note').textContent = th.cpuSpeedLimit != null ? `CPU limited to ${th.cpuSpeedLimit}%. Expect slower tok/s.` : 'macOS reports a thermal limit.';
    } else if (th.state === 'nominal') {
      tEl.innerHTML = `${ICON.ok} Nominal`;
      setState(tEl, 'ok');
      const bits = [];
      if (mm?.cpuTempC != null) bits.push(`CPU ${Math.round(mm.cpuTempC)}°C`);
      const rpm = (mm?.fans || []).map((f) => f.rpm).filter((r) => r != null);
      if (rpm.length) bits.push(Math.max(...rpm) > 0 ? `fans ${Math.round(Math.max(...rpm)).toLocaleString()} rpm` : 'fans off');
      V('thermal-note').textContent = bits.length ? bits.join(' · ') : 'No thermal limits.';
    } else {
      tEl.textContent = 'Unknown';
      setState(tEl, null);
      V('thermal-note').textContent = 'Not readable here.';
    }
  }

  // ------------------------------------------------------------ apps using memory
  let appsSig = '';
  function renderTopApps(apps) {
    if (!apps) return;
    const sig = JSON.stringify(apps.map((a) => [a.name, Math.round(a.bytes / GiB * 10)]));
    if (sig === appsSig) return;
    appsSig = sig;
    const ul = $('#apps');
    if (!apps.length) { ul.innerHTML = '<li class="empty">Nothing is holding much memory.</li>'; return; }
    const max = apps[0].bytes || 1;
    ul.innerHTML = apps.map((a) => `<li>
      <span class="app-name">${esc(a.name)}</span>
      <span class="app-bar" aria-hidden="true"><span style="width:${((a.bytes / max) * 100).toFixed(1)}%"></span></span>
      <span class="app-size">${gb(a.bytes)}</span>
    </li>`).join('');
  }

  // ------------------------------------------------------------ models
  function runtimeSignature(rts) {
    return JSON.stringify(rts.map((r) => [r.id, r.online, r.note, r.models.map((m) => [m.key, m.loaded, m.fit, m.pending, m.contextLength, m.sizeBytes, Math.round((m.freeBytes || 0) / GiB * 2)])]));
  }

  function fitCell(m) {
    const f = FIT[m.fit] || FIT.unknown;
    let detail = '';
    if (m.fit === 'loaded' && m.contextLength) detail = `${Number(m.contextLength).toLocaleString()} ctx`;
    else if (m.needBytes && (m.fit === 'close-apps' || m.fit === 'unload-first')) detail = `needs about ${gb(m.needBytes)}, ${gb(m.freeBytes)} free`;
    else if (m.needBytes && m.fit !== 'loaded') detail = `needs about ${gb(m.needBytes)}`;
    const cls = `fit fit-${m.fit || 'unknown'}`;
    return `<span class="${cls}">${ICON[f.icon]}${f.text}</span>${detail ? `<span class="fit-detail">${detail}</span>` : ''}`;
  }

  function actionCell(rt, m) {
    const label = esc(m.name);
    const id = esc(`${rt.id}|${m.key}`);
    if (m.pending) {
      const verb = { loading: 'Loading', unloading: 'Unloading', benchmarking: 'Benchmarking' }[m.pending] || 'Working';
      return `<div class="actions"><button type="button" class="btn" disabled aria-busy="true" data-focus="${id}|busy">${verb}…</button></div>`;
    }
    const canControl = rt.control !== 'none' && rt.online;
    const parts = [];
    if (m.loaded) {
      parts.push(`<button type="button" class="btn btn-primary" data-act="bench" data-rt="${esc(rt.id)}" data-key="${esc(m.key)}" data-focus="${id}|bench" aria-label="Benchmark ${label}">Benchmark</button>`);
      if (canControl) parts.push(`<button type="button" class="btn" data-act="unload" data-rt="${esc(rt.id)}" data-key="${esc(m.key)}" data-focus="${id}|unload" aria-label="Unload ${label}">Unload</button>`);
    } else if (canControl) {
      const blocked = m.fit === 'too-big';
      parts.push(`<button type="button" class="btn" data-act="load" data-rt="${esc(rt.id)}" data-key="${esc(m.key)}" data-focus="${id}|load" aria-label="Load ${label}"${blocked ? ' disabled' : ''}>Load</button>`);
    }
    return `<div class="actions">${parts.join('')}</div>`;
  }

  function renderRuntimes(rts) {
    const sig = runtimeSignature(rts);
    if (sig === state.runtimeSig) return;
    state.runtimeSig = sig;

    // Keep keyboard focus stable across re-renders.
    const focusKey = document.activeElement?.dataset?.focus;

    const shown = rts.filter((r) => r.online || r.models.length);
    const host = $('#runtimes');
    if (!shown.length) {
      host.innerHTML = `<div class="runtime"><p class="runtime-note">No local model server found. Open LM Studio (or start Ollama) and this page picks it up within a few seconds.</p></div>`;
      return;
    }

    host.innerHTML = shown.map((rt) => {
      const loadedCount = rt.models.filter((m) => m.loaded).length;
      let note = rt.note ? esc(rt.note).replace(/`([^`]+)`/g, '<code>$1</code>') : '';
      if (!rt.online) note = `${esc(rt.label)} isn't running. Open it to load or benchmark models.${note ? ' ' + note : ''}`;
      const rows = rt.models.length
        ? rt.models.map((m) => {
            const tags = [m.format, m.quant, m.params, m.vision && 'Vision', m.tools && 'Tools']
              .filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
            return `<tr>
              <th scope="row"><span class="model-name">${esc(m.name)}</span>${m.publisher ? `<span class="model-meta">${esc(m.publisher)}</span>` : ''}</th>
              <td>${tags || '<span class="model-meta">–</span>'}</td>
              <td class="num">${gb(m.loadedBytes || m.sizeBytes)}</td>
              <td>${fitCell(m)}</td>
              <td>${actionCell(rt, m)}</td>
            </tr>`;
          }).join('')
        : `<tr><td colspan="5" class="empty">${rt.online ? 'Running, but no models installed.' : 'No models found.'}</td></tr>`;

      return `<section class="runtime" aria-labelledby="rt-${esc(rt.id)}">
        <div class="runtime-head">
          <h3 id="rt-${esc(rt.id)}">${esc(rt.label)}</h3>
          <span class="chip" data-on="${rt.online}">${rt.online ? ICON.ok + 'Running' : ICON.none + 'Not running'}</span>
          ${rt.online ? `<span class="endpoint">${esc(rt.endpoint)}</span>` : ''}
          <span class="endpoint" style="margin-left:auto">${loadedCount} loaded · ${rt.models.length} installed${rt.version ? ` · v${esc(rt.version)}` : ''}</span>
        </div>
        ${note ? `<p class="runtime-note">${note}</p>` : ''}
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">${esc(rt.label)} models</caption>
            <thead><tr>
              <th scope="col">Model</th><th scope="col">Format</th><th scope="col" class="num">Size</th>
              <th scope="col">Memory fit</th><th scope="col"><span class="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
    }).join('');

    if (focusKey) {
      const base = focusKey.split('|').slice(0, -1).join('|');
      const el = host.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)
        || [...host.querySelectorAll('[data-focus]')].find((b) => b.dataset.focus.startsWith(base + '|'));
      if (el) el.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------ actions
  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function modelByKey(rtId, key) {
    const rt = state.snap?.runtimes.find((r) => r.id === rtId);
    return rt?.models.find((m) => m.key === key);
  }

  $('#runtimes').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, rt, key } = btn.dataset;
    const m = modelByKey(rt, key);
    const name = m?.name || key;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    announce(`${{ load: 'Loading', unload: 'Unloading', bench: 'Benchmarking' }[act]} ${name}`);
    try {
      if (act === 'bench') {
        const r = await post('/api/bench', { runtime: rt, key, promptType: $('#prompt-type').value });
        announce(`${name}: ${r.decodeTps} tokens per second decode, first token in ${r.ttftSec} seconds.`);
        loadBench();
      } else {
        await post(`/api/${act}`, { runtime: rt, key });
        announce(`${name} ${act === 'load' ? 'loaded' : 'unloaded'}.`);
      }
    } catch (err) {
      toast(err.message);
    }
  });

  $('#refresh').addEventListener('click', async () => {
    try { await post('/api/refresh'); announce('Refreshed.'); } catch (e) { toast(e.message); }
  });

  // ------------------------------------------------------------ benchmarks
  async function loadBench() {
    const list = await fetch('/api/bench').then((r) => r.json()).catch(() => []);
    const sig = JSON.stringify(list.map((r) => r.id));
    if (sig === state.benchSig) return;
    state.benchSig = sig;
    const tbody = $('#bench-table tbody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No runs yet.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((r) => `<tr>
      <td><time datetime="${esc(r.at)}">${esc(dateShort(r.at))}</time></td>
      <th scope="row"><span class="model-name">${esc(r.model)}</span><span class="model-meta">${esc(r.runtime)}</span></th>
      <td>${esc(r.promptLabel)}</td>
      <td class="num"><strong>${r.decodeTps ?? '–'}</strong></td>
      <td class="num">${r.prefillTps ?? '–'}</td>
      <td class="num">${r.ttftSec != null ? `${r.ttftSec}s` : '–'}</td>
      <td class="num">${r.completionTokens}${r.tokenCountExact ? '' : '<span class="sr-only"> (estimated)</span>*'}</td>
    </tr>`).join('');
  }

  // ------------------------------------------------------------ log
  function renderLog(events) {
    const ul = $('#log');
    if (!events?.length) { ul.innerHTML = '<li class="empty">Nothing yet.</li>'; return; }
    ul.innerHTML = events.slice().reverse().map((e) =>
      `<li class="k-${esc(e.kind)}"><time datetime="${esc(e.at)}">${esc(timeShort(e.at))}</time><span>${esc(e.text)}</span></li>`).join('');
  }

  // ------------------------------------------------------------ charts
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function drawChart(canvas, series, { max, unit = '' }) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 36, r: 6, t: 6, b: 16 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;

    // grid
    ctx.strokeStyle = cssVar('--line');
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '11px ui-sans-serif, -apple-system, sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = pad.t + (ih * i) / 2;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      const val = max * (1 - i / 2);
      ctx.fillText(`${val >= 10 ? Math.round(val) : val.toFixed(1)}${unit}`, 2, y + 4);
    }
    ctx.fillText('15 min ago', pad.l, h - 2);
    const nowW = ctx.measureText('now').width;
    ctx.fillText('now', w - pad.r - nowW, h - 2);

    const N = 450;
    series.forEach((s) => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(s.dash ? [5, 4] : []);
      ctx.beginPath();
      let started = false;
      const off = N - s.values.length;
      s.values.forEach((v, i) => {
        if (v == null) { started = false; return; }
        const x = pad.l + ((off + i) / (N - 1)) * iw;
        const y = pad.t + ih - Math.min(1, v / max) * ih;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  function stats(vals) {
    const v = vals.filter((x) => x != null);
    if (!v.length) return null;
    return { min: Math.min(...v), max: Math.max(...v), now: v[v.length - 1] };
  }

  function renderCharts() {
    const h = state.history;
    const s = state.snap;
    if (!s) return;
    const a = cssVar('--accent');
    const b = cssVar('--accent-2');
    const totalGB = s.hardware.memory.totalBytes / GiB;

    const mem = h.map((p) => p.memUsed / GiB);
    const model = h.map((p) => p.modelBytes / GiB);
    drawChart($('#c-mem'), [{ values: mem, color: a }, { values: model, color: b, dash: true }], { max: Math.ceil(totalGB), unit: 'G' });
    const ms = stats(mem);
    V('mem-sum').textContent = ms ? `In use now ${ms.now.toFixed(1)} GB, peak ${ms.max.toFixed(1)} GB. Models hold ${(model.at(-1) || 0).toFixed(1)} GB.` : '';
    $('#c-mem').setAttribute('aria-label', `Memory history. ${V('mem-sum').textContent}`);

    const gpu = h.map((p) => p.gpuPct);
    const cpu = h.map((p) => p.cpuPct);
    drawChart($('#c-gpu'), [{ values: gpu, color: a }, { values: cpu, color: b, dash: true }], { max: 100, unit: '%' });
    const gs = stats(gpu);
    const cs = stats(cpu);
    V('gpu-sum').textContent = gs
      ? `GPU now ${gs.now}%, peak ${gs.max}%. CPU now ${cs?.now ?? '–'}%.`
      : `GPU readings need macmon. CPU now ${cs?.now ?? '–'}%, peak ${cs?.max ?? '–'}%.`;
    $('#c-gpu').setAttribute('aria-label', `GPU and CPU history. ${V('gpu-sum').textContent}`);

    const swap = h.map((p) => p.swapUsed / GiB);
    const ss = stats(swap);
    drawChart($('#c-swap'), [{ values: swap, color: a }], { max: Math.max(2, Math.ceil((ss?.max || 0) * 1.2)), unit: 'G' });
    V('swap-sum').textContent = ss ? `Now ${ss.now.toFixed(2)} GB, peak ${ss.max.toFixed(2)} GB.` : '';
    $('#c-swap').setAttribute('aria-label', `Swap history. ${V('swap-sum').textContent}`);
  }

  // ------------------------------------------------------------ data flow
  function apply(snap) {
    state.snap = snap;
    renderTiles(snap);
    renderTopApps(snap.hardware.topApps);
    renderRuntimes(snap.runtimes);
    renderLog(snap.events);
    const sel = $('#prompt-type');
    if (!sel.options.length && snap.bench?.prompts) {
      sel.innerHTML = Object.entries(snap.bench.prompts).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    }
  }

  function setConn(stateName, text) {
    const c = $('#conn');
    c.dataset.state = stateName;
    $('.conn-text', c).textContent = text;
  }

  async function init() {
    try {
      const snap = await fetch('/api/snapshot').then((r) => r.json());
      state.history = snap.history || [];
      apply(snap);
      renderCharts();
    } catch {
      setConn('down', 'Rig server not reachable');
    }
    loadBench();

    const es = new EventSource('/api/stream');
    es.onopen = () => setConn('live', 'Live');
    es.onerror = () => setConn('down', 'Reconnecting…');
    es.onmessage = (ev) => {
      const snap = JSON.parse(ev.data);
      const last = state.history.at(-1);
      if (!last || snap.at > last.t) {
        const hw = snap.hardware;
        state.history.push({
          t: snap.at,
          memUsed: hw.memory.usedBytes,
          swapUsed: hw.memory.swapUsedBytes,
          modelBytes: snap.budget.modelBytes,
          cpuPct: hw.cpuPct,
          gpuPct: hw.macmon?.gpuPct ?? null,
        });
        if (state.history.length > 450) state.history.shift();
      }
      apply(snap);
      renderCharts();
    };

    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderCharts, 150); });
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', renderCharts);
  }

  init();
})();
