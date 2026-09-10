/**
 * UPDATE по белому списку колонок: в SET попадают только поля, присутствующие в patch со
 * значением !== undefined (null — осознанный сброс в NULL). Имена колонок берутся из
 * allowlist вызывающего, а не из patch, поэтому подставить в SQL чужое имя нельзя.
 *
 * Возвращает null, если обновлять нечего.
 */
export function buildUpdate(
  table: string,
  where: string,
  allowed: readonly string[],
  patch: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>> = {},
): { sql: string; params: Record<string, unknown> } | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = {};
  for (const col of allowed) {
    const v = patch[col];
    if (v === undefined) continue;
    sets.push(`${col} = @${col}`);
    params[col] = v;
  }
  if (sets.length === 0) return null;
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`, params };
}
