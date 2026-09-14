const RU_LAT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function translit(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) out += RU_LAT[ch] ?? ch;
  return out;
}

export const EMPLOYEE_LOGIN_MAX = 64;
export const DEPARTMENT_SLUG_MAX = 32;

/** «Иванов Иван Иванович» → ivanov.ii; одно слово → ivanov. Латиница остаётся как есть. */
export function loginFromFio(fio: string): string {
  const words = fio
    .split(/\s+/)
    .map((w) => translit(w).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  if (words.length === 0) return 'emp';
  const [surname, ...rest] = words as [string, ...string[]];
  const initials = rest.slice(0, 2).map((w) => w[0]).join('');
  const base = surname.slice(0, EMPLOYEE_LOGIN_MAX - (initials ? initials.length + 1 : 0)).replace(/-+$/, '');
  return initials ? `${base}.${initials}` : base;
}

/** «Отдел закупок» → otdel-zakupok. */
export function slugFromName(name: string): string {
  const slug = translit(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, DEPARTMENT_SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'dept';
}

/** base, затем base2, base3… (sep между основой и номером), не длиннее maxLen. */
export function uniqueId(base: string, maxLen: number, sep: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = sep + String(n);
    const candidate = base.slice(0, maxLen - suffix.length).replace(/[._-]+$/, '') + suffix;
    if (!taken(candidate)) return candidate;
  }
}
