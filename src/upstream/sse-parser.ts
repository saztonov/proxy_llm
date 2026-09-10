import { StringDecoder } from 'node:string_decoder';

export interface SseEvent {
  data: string;
  event?: string;
  id?: string;
}

export class SseBufferOverflowError extends Error {
  override readonly name = 'SseBufferOverflowError';
  constructor(readonly limit: number) {
    super(`sse buffer exceeded ${limit} bytes`);
  }
}

const LF = 0x0a;
const CR = 0x0d;
const COLON = 0x3a;
const SPACE = 0x20;
const BOM = 0xfeff;

/**
 * Инкрементальный парсер Server-Sent Events поверх бинарных чанков.
 *
 * - Декодирование UTF-8 через StringDecoder: multi-byte символ может быть разрезан границей чанка.
 * - Строки заканчиваются `\n`, `\r\n` или `\r` (WHATWG SSE); событие завершается пустой строкой,
 *   то есть разделителями `\n\n`, `\r\n\r\n`, `\r\r`. Одинокий `\r` в конце чанка придерживается
 *   до следующего чанка — иначе `\r` + `\n` из соседних чанков превратились бы в две пустые строки.
 * - Внутри события: `data: x` (несколько строк data объединяются через `\n`; ровно один пробел
 *   после двоеточия удаляется), `event: x`, `id: x`. Строки с `:` в начале — комментарии
 *   (OpenRouter шлёт `: OPENROUTER PROCESSING` как keep-alive), неизвестные поля игнорируются,
 *   строка без двоеточия — имя поля с пустым значением.
 * - Событие без единой data-строки не возвращается (по спецификации оно не диспатчится);
 *   накопленные для него event/id отбрасываются.
 * - Недоставленный остаток (незавершённая строка + накопленные data-строки) ограничен
 *   maxBufferedBytes: при превышении бросается SseBufferOverflowError — защита от провайдера,
 *   который шлёт бесконечную строку без разделителей.
 */
export class SseParser {
  private readonly decoder = new StringDecoder('utf8');
  /** Текст, ещё не разобранный на строки (хвост без завершающего разделителя). */
  private tail = '';
  /** Позиция в tail, до которой разделителей точно нет — чтобы не сканировать хвост заново. */
  private scanFrom = 0;
  private dataLines: string[] = [];
  /** Байты накопленных data-строк (с учётом `\n` между ними) — для лимита буфера. */
  private dataBytes = 0;
  private eventName: string | undefined;
  private id: string | undefined;
  private started = false;

  constructor(private readonly maxBufferedBytes = 1_048_576) {}

  /** Скормить чанк; вернуть завершённые события (возможно пустой массив). */
  push(chunk: Uint8Array | string): SseEvent[] {
    let text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (!this.started && text !== '') {
      this.started = true;
      // BOM в начале потока спецификация предписывает отбросить.
      if (text.charCodeAt(0) === BOM) text = text.slice(1);
    }
    this.tail += text;
    const events = this.drainLines(false);
    this.checkOverflow();
    return events;
  }

  /** На конце потока: незавершённый хвост как событие (если в нём есть data), плюс остаток StringDecoder. */
  flush(): SseEvent[] {
    this.tail += this.decoder.end();
    const events = this.drainLines(true);
    if (this.tail !== '') {
      // Последняя строка без завершающего перевода строки.
      this.parseField(this.tail);
      this.tail = '';
    }
    this.scanFrom = 0;
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private drainLines(eof: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    const buf = this.tail;
    let pos = 0;
    let i = this.scanFrom;
    while (i < buf.length) {
      const c = buf.charCodeAt(i);
      if (c !== LF && c !== CR) {
        i++;
        continue;
      }
      let next = i + 1;
      if (c === CR) {
        // `\r` последним символом чанка: возможно, это половина `\r\n` — непустую строку
        // придерживаем до следующего чанка. Пустую строку можно завершить сразу: пришедший
        // следом `\n` даст ещё одну пустую строку, а повторный dispatch без данных — no-op.
        if (next === buf.length && !eof && i > pos) break;
        if (next < buf.length && buf.charCodeAt(next) === LF) next++;
      }
      const ev = this.processLine(buf.slice(pos, i));
      if (ev) events.push(ev);
      pos = next;
      i = next;
    }
    this.tail = pos === 0 ? buf : buf.slice(pos);
    this.scanFrom = i - pos;
    return events;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    this.parseField(line);
    return undefined;
  }

  private parseField(line: string): void {
    if (line.charCodeAt(0) === COLON) return; // комментарий
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === SPACE) value = value.slice(1);
    }
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        this.dataBytes += Buffer.byteLength(value) + 1;
        break;
      case 'event':
        this.eventName = value;
        break;
      case 'id':
        // Спецификация: id, содержащий NUL, игнорируется.
        if (!value.includes('\0')) this.id = value;
        break;
      default:
        // `retry` и неизвестные поля игнорируем.
        break;
    }
  }

  private dispatch(): SseEvent | undefined {
    let ev: SseEvent | undefined;
    if (this.dataLines.length > 0) {
      ev = { data: this.dataLines.join('\n') };
      if (this.eventName !== undefined) ev.event = this.eventName;
      if (this.id !== undefined) ev.id = this.id;
    }
    this.dataLines = [];
    this.dataBytes = 0;
    this.eventName = undefined;
    this.id = undefined;
    return ev;
  }

  private checkOverflow(): void {
    // Код-юнит UTF-16 занимает в UTF-8 от 1 до 3 байт: пока верхняя оценка укладывается в лимит,
    // точный подсчёт байтов хвоста не нужен.
    if (this.dataBytes + this.tail.length * 3 <= this.maxBufferedBytes) return;
    if (this.dataBytes + Buffer.byteLength(this.tail) > this.maxBufferedBytes) {
      throw new SseBufferOverflowError(this.maxBufferedBytes);
    }
  }
}

export type ChunkMeaning =
  | { kind: 'done' }
  | { kind: 'error'; code: string | null; message: string; httpCode: number | null; raw: unknown }
  | {
      kind: 'chunk';
      id?: string;
      model?: string;
      usage?: Record<string, unknown>;
      finishReason: string | null;
      hasChoices: boolean;
    }
  | { kind: 'opaque' };

type ChatChunk = Extract<ChunkMeaning, { kind: 'chunk' }>;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Целое 400..599 — числом или трёхзначной строкой; иначе null. */
function asHttpCode(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : null;
}

/**
 * Трактовка одного события OpenAI-совместимого chat-стрима:
 * - data === '[DONE]' (после trim) → done;
 * - data не парсится как JSON или не объект → opaque;
 * - объект с полем `error` (объект) и без непустого массива `choices` → error
 *   (code: string, number → String(n), иначе null; message или 'upstream error';
 *   httpCode: error.code либо error.status, если это целое 400..599; raw — весь объект);
 * - иначе → chunk (id/model, если строки; usage, если объект; finishReason из choices[0];
 *   hasChoices — непустой ли массив choices). Объект с `error` при непустых choices — chunk.
 */
export function interpretChatChunk(ev: SseEvent): ChunkMeaning {
  const data = ev.data.trim();
  if (data === '[DONE]') return { kind: 'done' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: 'opaque' };
  }
  const obj = asRecord(parsed);
  if (!obj) return { kind: 'opaque' };

  const choices = Array.isArray(obj.choices) ? (obj.choices as unknown[]) : undefined;
  const hasChoices = choices !== undefined && choices.length > 0;

  const error = asRecord(obj.error);
  if (error && !hasChoices) {
    const code =
      typeof error.code === 'string' ? error.code : typeof error.code === 'number' ? String(error.code) : null;
    const message = typeof error.message === 'string' ? error.message : 'upstream error';
    const httpCode = asHttpCode(error.code) ?? asHttpCode(error.status);
    return { kind: 'error', code, message, httpCode, raw: obj };
  }

  const first = hasChoices ? asRecord(choices[0]) : undefined;
  const finishReason = first && typeof first.finish_reason === 'string' ? first.finish_reason : null;
  const chunk: ChatChunk = { kind: 'chunk', finishReason, hasChoices };
  if (typeof obj.id === 'string') chunk.id = obj.id;
  if (typeof obj.model === 'string') chunk.model = obj.model;
  const usage = asRecord(obj.usage);
  if (usage) chunk.usage = usage;
  return chunk;
}
