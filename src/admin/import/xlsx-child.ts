/**
 * Дочерний процесс разбора xlsx. Живёт ровно один файл: получает байты по IPC, читает первый
 * лист, отправляет строки и завершается. Отдельный процесс нужен, чтобы архивная бомба или
 * враждебный XML упирались в лимиты родителя (память, время), а не в процесс прокси.
 */
import { readSheet } from 'read-excel-file/node';

export const MAX_ROWS = 5000;
export const MAX_COLS = 20;

export type ChildReply = { ok: true; rows: string[][]; truncated: boolean } | { ok: false; error: string };

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v);
}

async function parse(input: Uint8Array): Promise<ChildReply> {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const sheet = await readSheet(buf, 1);
  const truncated = sheet.length > MAX_ROWS || sheet.some((r) => r.length > MAX_COLS);
  const rows = sheet.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map(cellText));
  return { ok: true, rows, truncated };
}

function reply(msg: ChildReply): void {
  process.send!(msg, () => process.exit(0));
}

process.once('message', (msg: unknown) => {
  if (!(msg instanceof Uint8Array)) {
    reply({ ok: false, error: 'bad input' });
    return;
  }
  parse(msg).then(reply, (err: unknown) => {
    reply({ ok: false, error: err instanceof Error ? err.name : 'error' });
  });
});
