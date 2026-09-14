import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { adminCall, loginAs, seedAdmin, type AdminSession } from './helpers/admin-session.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Минимальный xlsx с одним листом; значения — через sharedStrings, как пишет Excel. */
function makeXlsx(rows: string[][]): Buffer {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const si = (s: string) => {
    if (!index.has(s)) { index.set(s, strings.length); strings.push(s); }
    return index.get(s)!;
  };
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) =>
    v === '' ? '' : `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>`).join('');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '</Types>'),
    '_rels/.rels': strToU8(`${XML}<Relationships xmlns="${NS_PKG_REL}">`
      + `<Relationship Id="rId1" Type="${NS_DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`${XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_DOC_REL}">`
      + '<sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8(`${XML}<Relationships xmlns="${NS_PKG_REL}">`
      + `<Relationship Id="rId1" Type="${NS_DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${NS_DOC_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`${XML}<worksheet xmlns="${NS_MAIN}"><sheetData>${sheetRows}</sheetData></worksheet>`),
  };
  files['xl/sharedStrings.xml'] = strToU8(`${XML}<sst xmlns="${NS_MAIN}" count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') + '</sst>');
  return Buffer.from(zipSync(files));
}

interface Summary {
  rowsTotal: number;
  departmentsCreated: Array<{ name: string; slug: string }>;
  employeesCreated: Array<{ row: number; fio: string; login: string; department: string }>;
  skippedExisting: Array<{ row: number; fio: string; department: string }>;
  skippedDuplicate: Array<{ row: number; fio: string }>;
  invalid: Array<{ row: number; reason: string }>;
  warnings: string[];
}

describe('directory import from xlsx', () => {
  let b: AppBundle;
  let s: AdminSession;

  beforeAll(async () => {
    b = await buildApp(makeTestConfig());
    await seedAdmin(b);
    s = await loginAs(b);
  });
  afterAll(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
  });

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => adminCall(b, s, method, url, payload);
  const upload = (body: Buffer, headers: Record<string, string> = {}) =>
    adminCall(b, s, 'POST', '/admin/api/directory/import', body, { 'content-type': XLSX_MIME, ...headers });

  const FILE: string[][] = [
    ['Список сотрудников на 01.09'],
    ['ФИО', 'Отдел', 'Примечание'],
    ['Иванов Иван Иванович', ' разработка ', 'новый'],
    ['петров  петр', 'Разработка', ''],
    ['Сидорова Анна', 'Отдел закупок', ''],
    ['Иванов Иван Иванович', 'Отдел закупок', ''],
    ['', 'Отдел закупок', ''],
    ['Козлов Кирилл', '', ''],
  ];

  it('creates missing departments and new employees, skips existing names and reports everything', async () => {
    const dept = (await call('POST', '/admin/api/departments', { slug: 'dev', name: 'Разработка' })).json().department;
    expect((await call('POST', '/admin/api/employees', { login: 'petrov', displayName: 'Петров Пётр', departmentId: dept.id })).statusCode).toBe(201);

    const res = await upload(makeXlsx(FILE));
    expect(res.statusCode).toBe(200);
    const sum = res.json().summary as Summary;
    expect(sum.rowsTotal).toBe(6);
    expect(sum.departmentsCreated).toEqual([{ name: 'Отдел закупок', slug: 'otdel-zakupok' }]);
    expect(sum.employeesCreated).toEqual([
      { row: 3, fio: 'Иванов Иван Иванович', login: 'ivanov.ii', department: 'Разработка' },
      { row: 5, fio: 'Сидорова Анна', login: 'sidorova.a', department: 'Отдел закупок' },
    ]);
    expect(sum.skippedExisting).toEqual([{ row: 4, fio: 'петров петр', department: 'Разработка' }]);
    expect(sum.skippedDuplicate).toEqual([{ row: 6, fio: 'Иванов Иван Иванович' }]);
    expect(sum.invalid.map((x) => x.row)).toEqual([7, 8]);

    const emps = (await call('GET', '/admin/api/employees')).json().employees as Array<{ id: number; login: string; departmentId: number }>;
    const ivanov = emps.find((e) => e.login === 'ivanov.ii')!;
    expect(ivanov.departmentId).toBe(dept.id);

    // Импорт публикует снапшот реестра: сотруднику сразу можно выпустить ключ.
    expect((await call('POST', '/admin/api/agent-tokens', { principalType: 'employee', employeeId: ivanov.id })).statusCode).toBe(201);

    const audit = (await call('GET', '/admin/api/audit')).json().entries as Array<{ action: string; details: Record<string, unknown> }>;
    const entry = audit.find((e) => e.action === 'directory.import')!;
    expect(entry.details).toEqual({ rows: 6, departmentsCreated: 1, employeesCreated: 2, skipped: 2, invalid: 2 });
    expect(JSON.stringify(audit)).not.toContain('Сидорова');
  });

  it('is idempotent and gives colliding logins a numeric suffix', async () => {
    const again = (await upload(makeXlsx(FILE))).json().summary as Summary;
    expect(again.employeesCreated).toEqual([]);
    expect(again.departmentsCreated).toEqual([]);
    // Повтор Иванова в файле теперь тоже «уже есть в справочнике».
    expect(again.skippedExisting.map((x) => x.row)).toEqual([3, 4, 5, 6]);
    expect(again.skippedDuplicate).toEqual([]);

    const sum = (await upload(makeXlsx([['ФИО', 'Отдел'], ['Иванов Игорь Ильич', 'ОТДЕЛ ЗАКУПОК']]))).json().summary as Summary;
    expect(sum.employeesCreated).toEqual([{ row: 2, fio: 'Иванов Игорь Ильич', login: 'ivanov.ii2', department: 'Отдел закупок' }]);
  });

  it('rejects files that are not a readable xlsx without hurting the process', async () => {
    const noHeader = await upload(makeXlsx([['Имя', 'Подразделение'], ['Иванов', 'Разработка']]));
    expect(noHeader.statusCode).toBe(400);
    expect(noHeader.json().error.code).toBe('invalid_file');

    expect((await upload(Buffer.from('ФИО;Отдел\nИванов;Разработка'))).json().error.message).toBe('Нужен файл .xlsx');
    const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    expect((await upload(ole2)).json().error.message).toContain('.xls');

    const garbage = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 7)]);
    const broken = await upload(garbage);
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe('invalid_file');

    expect((await upload(Buffer.alloc(1024 * 1024 + 1, 0x50))).statusCode).toBe(413);
    expect((await call('POST', '/admin/api/directory/import', { rows: [] })).statusCode).toBe(400);
    expect((await upload(makeXlsx(FILE), { 'x-csrf-token': 'wrong' })).statusCode).toBe(403);

    expect((await call('GET', '/admin/api/departments')).statusCode).toBe(200);
  });
});
