import { describe, expect, it } from 'vitest';
import { loginFromFio, slugFromName, translit, uniqueId } from '../src/utils/translit.js';
import { EMPLOYEE_LOGIN, SLUG } from '../src/cli/admin.js';

describe('translit', () => {
  it('transliterates Russian letters and keeps latin and digits', () => {
    expect(translit('Щукин Жора Хачатурян Цой Юля Ёлкина')).toBe('shchukin zhora khachaturyan tsoy yulya elkina');
    expect(translit('Объект №5 Office')).toBe('obekt №5 office');
  });

  it('builds a login as surname plus initials', () => {
    expect(loginFromFio('Иванов Иван Иванович')).toBe('ivanov.ii');
    expect(loginFromFio('  Петрова   Анна ')).toBe('petrova.a');
    expect(loginFromFio('Сидоров')).toBe('sidorov');
    expect(loginFromFio('Петров-Водкин Кузьма Сергеевич')).toBe('petrov-vodkin.ks');
    expect(loginFromFio('John Smith')).toBe('john.s');
    expect(loginFromFio('*** ---')).toBe('emp');
    const long = loginFromFio('А'.repeat(100) + ' Борис Викторович');
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith('.bv')).toBe(true);
    for (const fio of ['Иванов Иван Иванович', 'Ъ Ь', '-Эмиль', 'Ян 2']) expect(loginFromFio(fio)).toMatch(EMPLOYEE_LOGIN);
  });

  it('builds a slug from a department name', () => {
    expect(slugFromName('Отдел закупок')).toBe('otdel-zakupok');
    expect(slugFromName('  ПТО / сметы (2025) ')).toBe('pto-smety-2025');
    expect(slugFromName('!!!')).toBe('dept');
    const long = slugFromName('Управление капитального строительства и реконструкции');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(SLUG);
  });

  it('adds a numeric suffix within the length limit', () => {
    const taken = new Set(['ivanov.ii', 'ivanov.ii2']);
    expect(uniqueId('ivanov.ii', 64, '', (s) => taken.has(s))).toBe('ivanov.ii3');
    expect(uniqueId('otdel', 32, '-', (s) => s === 'otdel')).toBe('otdel-2');
    const base = 'a'.repeat(32);
    const next = uniqueId(base, 32, '-', (s) => s === base);
    expect(next).toBe('a'.repeat(30) + '-2');
    expect(next).toMatch(SLUG);
  });
});
