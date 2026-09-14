import type { DirectoryRepo } from '../../storage/directory-repo.js';
import { SLUG, EMPLOYEE_LOGIN } from '../../cli/admin.js';
import { DEPARTMENT_SLUG_MAX, EMPLOYEE_LOGIN_MAX, loginFromFio, slugFromName, uniqueId } from '../../utils/translit.js';

/** Лимит имени отдела и сотрудника — как в zod-схемах маршрутов справочника. */
const NAME_MAX = 100;
const HEADER_SCAN_ROWS = 10;

export class ImportFormatError extends Error {}

export interface ImportSummary {
  rowsTotal: number;
  departmentsCreated: Array<{ name: string; slug: string }>;
  employeesCreated: Array<{ row: number; fio: string; login: string; department: string }>;
  skippedExisting: Array<{ row: number; fio: string; department: string }>;
  skippedDuplicate: Array<{ row: number; fio: string }>;
  invalid: Array<{ row: number; reason: string }>;
  warnings: string[];
  truncated: boolean;
}

/** Значение для записи: без лишних пробелов, регистр как в файле. */
export const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Ключ сравнения: ещё и без регистра, ё = е. */
export const nameKey = (s: string): string => tidy(s).toLowerCase().replace(/ё/g, 'е');
const headerKey = (s: string): string => nameKey(s).replace(/[.\s]/g, '');

export function findHeader(rows: string[][]): { index: number; fio: number; dept: number } | null {
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const keys = rows[i]!.map(headerKey);
    const fio = keys.indexOf('фио');
    const dept = keys.indexOf('отдел');
    if (fio >= 0 && dept >= 0) return { index: i, fio, dept };
  }
  return null;
}

/**
 * Импорт строк листа в справочник. Вызывать внутри транзакции (ctx.change): отделы и
 * сотрудники создаются по ходу, а уникальность логинов и slug сверяется с БД.
 */
export function importDirectory(dir: DirectoryRepo, rows: string[][], truncated: boolean, now: number): ImportSummary {
  const header = findHeader(rows);
  if (!header) throw new ImportFormatError('Не найдены столбцы «ФИО» и «Отдел» (ищутся в первых 10 строках)');

  const summary: ImportSummary = {
    rowsTotal: 0, departmentsCreated: [], employeesCreated: [], skippedExisting: [],
    skippedDuplicate: [], invalid: [], warnings: [], truncated,
  };

  const depts = new Map<string, { id: number; name: string; enabled: boolean }>();
  for (const d of dir.listDepartments()) {
    // Список отсортирован «включённые первыми»: при одинаковых именах берём включённый.
    if (!depts.has(nameKey(d.name))) depts.set(nameKey(d.name), { id: d.id, name: d.name, enabled: d.enabled === 1 });
  }
  const existing = new Map<string, string>();
  for (const e of dir.listEmployees()) existing.set(nameKey(e.display_name), e.department_name);
  const seenInFile = new Set<string>();
  const disabledUsed = new Set<string>();

  for (let i = header.index + 1; i < rows.length; i++) {
    const cells = rows[i]!;
    const row = i + 1;
    const fio = tidy(cells[header.fio] ?? '');
    const deptName = tidy(cells[header.dept] ?? '');
    if (!fio && !deptName) continue;
    summary.rowsTotal++;

    if (!fio) { summary.invalid.push({ row, reason: 'не заполнено ФИО' }); continue; }
    if (!deptName) { summary.invalid.push({ row, reason: `не указан отдел (${fio})` }); continue; }
    if (fio.length > NAME_MAX) { summary.invalid.push({ row, reason: `ФИО длиннее ${NAME_MAX} символов` }); continue; }
    if (deptName.length > NAME_MAX) { summary.invalid.push({ row, reason: `название отдела длиннее ${NAME_MAX} символов (${fio})` }); continue; }

    const key = nameKey(fio);
    const had = existing.get(key);
    if (had !== undefined) { summary.skippedExisting.push({ row, fio, department: had }); continue; }
    if (seenInFile.has(key)) { summary.skippedDuplicate.push({ row, fio }); continue; }
    seenInFile.add(key);

    let dept = depts.get(nameKey(deptName));
    if (!dept) {
      const slug = uniqueId(slugFromName(deptName), DEPARTMENT_SLUG_MAX, '-', (s) => dir.getDepartmentBySlug(s) !== null);
      if (!SLUG.test(slug)) throw new Error(`generated slug is invalid: ${slug}`);
      const id = dir.createDepartment({ slug, name: deptName, max_concurrency: null, max_pending: null }, now);
      dept = { id, name: deptName, enabled: true };
      depts.set(nameKey(deptName), dept);
      summary.departmentsCreated.push({ name: deptName, slug });
    } else if (!dept.enabled) {
      disabledUsed.add(dept.name);
    }

    const login = uniqueId(loginFromFio(fio), EMPLOYEE_LOGIN_MAX, '', (s) => dir.getEmployeeByLogin(s) !== null);
    if (!EMPLOYEE_LOGIN.test(login)) throw new Error(`generated login is invalid: ${login}`);
    dir.createEmployee({
      login, display_name: fio, email: null, department_id: dept.id, max_concurrency: null, max_pending: null,
    }, now);
    summary.employeesCreated.push({ row, fio, login, department: dept.name });
  }

  for (const name of disabledUsed) {
    summary.warnings.push(`Отдел «${name}» выключен: добавленные в него сотрудники не смогут пользоваться ключами, пока отдел не включат`);
  }
  if (truncated) summary.warnings.push('Файл обрезан: обработаны только первые 5000 строк и 20 столбцов первого листа');
  return summary;
}
