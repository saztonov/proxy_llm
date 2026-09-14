import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ChildReply } from './xlsx-child.js';

export class ImportParseError extends Error {}

export interface ParseXlsxOptions {
  timeoutMs?: number;
  /** Граница по RSS дочернего процесса (Linux): буферы распаковки живут вне heap V8. */
  maxRssMb?: number;
}

export interface ParsedSheet {
  rows: string[][];
  truncated: boolean;
}

const RUNNING_TS = import.meta.url.endsWith('.ts');
const CHILD_PATH = fileURLToPath(new URL(RUNNING_TS ? './xlsx-child.ts' : './xlsx-child.js', import.meta.url));

function rssKb(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Первый лист xlsx как строки текста. Разбор идёт в отдельном процессе с лимитами памяти и времени. */
export function parseXlsxInChild(file: Buffer, opts: ParseXlsxOptions = {}): Promise<ParsedSheet> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRssKb = (opts.maxRssMb ?? 256) * 1024;

  return new Promise((resolve, reject) => {
    const child = fork(CHILD_PATH, [], {
      execArgv: [...(RUNNING_TS ? ['--import', 'tsx'] : []), '--max-old-space-size=128'],
      // Секреты прокси разбору файла не нужны.
      env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV ?? 'production' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    let killedFor: 'timeout' | 'memory' | null = null;

    const finish = (err: Error | null, value?: ParsedSheet) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(() => {
      killedFor = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    const watch = setInterval(() => {
      if (process.platform !== 'linux' || child.pid === undefined) return;
      const kb = rssKb(child.pid);
      if (kb !== null && kb > maxRssKb) {
        killedFor = 'memory';
        child.kill('SIGKILL');
      }
    }, 100);

    child.on('message', (msg: ChildReply) => {
      if (msg.ok) finish(null, { rows: msg.rows, truncated: msg.truncated });
      else finish(new ImportParseError('Файл не читается как таблица xlsx'));
    });
    child.on('error', () => finish(new ImportParseError('Не удалось запустить разбор файла')));
    child.on('exit', () => {
      if (killedFor === 'timeout') finish(new ImportParseError('Превышено время разбора файла'));
      else if (killedFor === 'memory') finish(new ImportParseError('Файл слишком сложный для разбора'));
      else finish(new ImportParseError('Файл не читается как таблица xlsx'));
    });

    child.send(file);
  });
}
