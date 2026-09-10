#!/usr/bin/env node
// Нагрузочная проверка агентского контура: N параллельных стримов, по одному ключу на
// поток (разные владельцы — иначе сработает лимит владельца ключа).
//
//   node scripts/load-agent.mjs --base https://<домен>/agent/v1 --tokens temp/agent-tokens.txt \
//        --parallel 40 [--prompt "..."] [--max-tokens 64]
//
// Файл ключей — по одному на строку; ключи в репозиторий не класть (temp/ в .gitignore).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({
  options: {
    base: { type: 'string' },
    tokens: { type: 'string' },
    parallel: { type: 'string', default: '10' },
    prompt: { type: 'string', default: 'Ответь одним словом: сколько будет 2+2?' },
    'max-tokens': { type: 'string', default: '64' },
  },
});
if (!o.base || !o.tokens) {
  console.error('usage: --base <url> --tokens <file> [--parallel N]');
  process.exit(2);
}
const tokens = readFileSync(o.tokens, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const n = Number(o.parallel);
if (tokens.length === 0) {
  console.error('no tokens in file');
  process.exit(2);
}

async function one(i) {
  const token = tokens[i % tokens.length];
  const t0 = performance.now();
  let ttfb = null;
  try {
    const res = await fetch(`${o.base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'default', stream: true, max_tokens: Number(o['max-tokens']), messages: [{ role: 'user', content: o.prompt }] }),
    });
    const reader = res.body.getReader();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (ttfb === null) ttfb = performance.now() - t0;
      text += new TextDecoder().decode(value);
    }
    const err = /"error"\s*:\s*\{[^}]*"code"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
    return { status: res.status, ttfb, total: performance.now() - t0, err };
  } catch (e) {
    return { status: 'network', ttfb, total: performance.now() - t0, err: String(e?.message ?? e) };
  }
}

const pct = (arr, p) => {
  if (arr.length === 0) return '—';
  const s = [...arr].sort((a, b) => a - b);
  return `${Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))])} ms`;
};

const started = performance.now();
const results = await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
const byStatus = {};
for (const r of results) {
  const key = r.err ? `${r.status}/${r.err}` : String(r.status);
  byStatus[key] = (byStatus[key] ?? 0) + 1;
}
const ttfbs = results.map((r) => r.ttfb).filter((x) => x !== null);
const totals = results.map((r) => r.total);
console.log(`requests: ${n}, distinct keys: ${Math.min(n, tokens.length)}, wall: ${Math.round(performance.now() - started)} ms`);
console.log('by status:', byStatus);
console.log(`TTFB p50 ${pct(ttfbs, 0.5)}, p95 ${pct(ttfbs, 0.95)}; total p50 ${pct(totals, 0.5)}, p95 ${pct(totals, 0.95)}`);
