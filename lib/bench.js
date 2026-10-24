// Decode / prefill benchmark over the OpenAI-compatible chat endpoint that
// LM Studio, Ollama, mlx_lm.server and llama.cpp all expose.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'bench.json');

const SHORT_PROMPT =
  'Write a clear, practical explanation of how a hash map handles collisions. ' +
  'Cover chaining and open addressing, and end with when you would pick each.';

const FILLER =
  'The quarterly report covers shipping volumes, warehouse throughput, staffing levels, ' +
  'vendor lead times, and customer support response times across four regions. ';

const PROMPTS = {
  short: { label: 'Short prompt', build: () => SHORT_PROMPT },
  long: {
    label: 'Long prompt (~4k tokens)',
    build: () => FILLER.repeat(150) + '\n\nSummarise the report above in three sentences.',
  },
};

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function saveHistory(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list.slice(-200), null, 2));
}

let running = null;

async function runBench({ endpoint, runtimeLabel, model, apiId, promptType = 'short', maxTokens = 300, temperature = 0.7 }) {
  if (running) throw new Error(`A benchmark is already running on ${running}`);
  const prompt = PROMPTS[promptType] || PROMPTS.short;
  running = model;
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 300000);

  const t0 = performance.now();
  let tFirst = null;
  let chunks = 0;
  let usage = null;

  try {
    const res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: apiId,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content: prompt.build() }],
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Server returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    const decoder = new TextDecoder();
    let buf = '';
    for await (const part of res.body) {
      buf += decoder.decode(part, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta;
        // Count reasoning tokens too: thinking models spend real decode time there.
        if (d && (d.content || d.reasoning_content || d.reasoning)) {
          if (tFirst == null) tFirst = performance.now();
          chunks++;
        }
      }
    }
  } finally {
    clearTimeout(killer);
    running = null;
  }

  const tEnd = performance.now();
  if (tFirst == null) throw new Error('The model returned no tokens');

  const completionTokens = usage?.completion_tokens || chunks;
  const promptTokens = usage?.prompt_tokens || null;
  const decodeSec = (tEnd - tFirst) / 1000;
  const ttftSec = (tFirst - t0) / 1000;

  const result = {
    id: Date.now().toString(36),
    at: new Date().toISOString(),
    runtime: runtimeLabel,
    model,
    promptType,
    promptLabel: prompt.label,
    temperature,
    promptTokens,
    completionTokens,
    tokenCountExact: !!usage?.completion_tokens,
    ttftSec: round(ttftSec, 2),
    decodeTps: decodeSec > 0 ? round((completionTokens - 1) / decodeSec, 1) : null,
    // On a short prompt, time-to-first-token is mostly request overhead, not
    // prompt processing, so a prefill rate there would mislead. Long prompt only.
    prefillTps: promptTokens >= 500 && ttftSec > 0 ? round(promptTokens / ttftSec, 0) : null,
    totalSec: round((tEnd - t0) / 1000, 2),
  };
  const history = loadHistory();
  history.push(result);
  saveHistory(history);
  return result;
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

module.exports = { runBench, loadHistory, PROMPTS, isRunning: () => running };
