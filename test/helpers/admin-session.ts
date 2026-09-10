import type { AppBundle } from '../../src/app.js';
import { createAdmin } from '../../src/cli/admin.js';

export const HOST = 'admin.test';
/** Браузер шлёт Origin на любой fetch с телом; без него мутирующий запрос отвергается. */
export const ORIGIN_HEADERS = { host: HOST, origin: `http://${HOST}` };
export const ADMIN_PASSWORD = 'correct horse battery staple';

export interface AdminSession {
  cookies: Record<string, string>;
  csrf: string;
  adminId: number;
}

type InjectResponse = Awaited<ReturnType<AppBundle['app']['inject']>>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface ParsedCookie {
  name: string;
  value: string;
  maxAge?: number;
  expires?: Date;
}

/** Как браузерная cookie-банка: пустое значение или истёкший срок удаляют cookie. */
export function absorbCookies(jar: Record<string, string>, res: InjectResponse): void {
  for (const c of res.cookies as ParsedCookie[]) {
    const expired =
      c.value === '' ||
      (c.maxAge !== undefined && c.maxAge <= 0) ||
      (c.expires !== undefined && c.expires.getTime() <= Date.now());
    if (expired) delete jar[c.name];
    else jar[c.name] = c.value;
  }
}

export function seedAdmin(bundle: AppBundle, login = 'root', password = ADMIN_PASSWORD): Promise<number> {
  return createAdmin(bundle.repos, { login, password });
}

export async function loginAs(bundle: AppBundle, login = 'root', password = ADMIN_PASSWORD): Promise<AdminSession> {
  const res = await bundle.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: ORIGIN_HEADERS, payload: { login, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookies: Record<string, string> = {};
  absorbCookies(cookies, res);
  const j = res.json() as { csrf: string; admin: { id: number } };
  return { cookies, csrf: j.csrf, adminId: j.admin.id };
}

/** Вызов API от имени сессии: cookie, Origin и CSRF-заголовок; cookie обновляются из ответа. */
export async function adminCall(
  bundle: AppBundle,
  s: AdminSession,
  method: Method,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<InjectResponse> {
  const res = await bundle.app.inject({
    method,
    url,
    cookies: s.cookies,
    headers: { ...ORIGIN_HEADERS, 'x-csrf-token': s.csrf, ...headers },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  absorbCookies(s.cookies, res);
  return res;
}
