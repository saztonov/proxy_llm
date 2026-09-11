import { describe, expect, it, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { absorbCookies, ORIGIN_HEADERS, adminCall, type AdminSession } from './helpers/admin-session.js';
import { DEFAULT_ADMIN_LOGIN, DEFAULT_ADMIN_PASSWORD_HASH } from '../src/admin/default-admin.js';
import { verifyPassword } from '../src/admin/auth/password.js';
import { openDb } from '../src/storage/db.js';
import { createRepos } from '../src/storage/repos.js';
import { createAdmin, disableAdmin, CliError } from '../src/cli/admin.js';

const DEFAULT_PASSWORD = 'qwertyui12345';
const NEW_PASSWORD = 'my own long passphrase 2026';

async function login(b: AppBundle, loginName: string, password: string) {
  const res = await b.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: ORIGIN_HEADERS, payload: { login: loginName, password } });
  const cookies: Record<string, string> = {};
  absorbCookies(cookies, res);
  return { res, session: res.statusCode === 200 ? { cookies, csrf: (res.json() as { csrf: string }).csrf, adminId: 0 } as AdminSession : null };
}

describe('built-in admin for the first login', () => {
  const bundles: AppBundle[] = [];
  const start = async (dbPath?: string) => {
    const b = await buildApp(makeTestConfig(dbPath ? { DB_PATH: dbPath } : {}));
    bundles.push(b);
    return b;
  };
  afterEach(async () => {
    for (const b of bundles.splice(0)) {
      await b.app.close();
      b.db.close();
      b.stopTickers();
    }
  });

  it('the stored hash really is the documented default password', async () => {
    expect(await verifyPassword(DEFAULT_PASSWORD, DEFAULT_ADMIN_PASSWORD_HASH)).toBe(true);
  });

  it('an empty database gets admin@test.com; logging in reports the default password', async () => {
    const b = await start();
    expect(b.repos.adminUsers.list().map((u) => u.login)).toEqual([DEFAULT_ADMIN_LOGIN]);
    const { res, session } = await login(b, DEFAULT_ADMIN_LOGIN, DEFAULT_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ defaultPassword: true, admin: { login: DEFAULT_ADMIN_LOGIN } });
    const me = await adminCall(b, session!, 'GET', '/admin/api/auth/me');
    expect(me.json()).toMatchObject({ defaultPassword: true });
  });

  it('after changing the password the flag is gone, the old password stops working, a restart keeps it', async () => {
    const path = makeTestConfig().DB_PATH;
    const b1 = await start(path);
    const { session } = await login(b1, DEFAULT_ADMIN_LOGIN, DEFAULT_PASSWORD);
    const changed = await adminCall(b1, session!, 'POST', '/admin/api/auth/change-password', { current: DEFAULT_PASSWORD, next: NEW_PASSWORD });
    expect(changed.statusCode).toBe(204);

    expect((await login(b1, DEFAULT_ADMIN_LOGIN, DEFAULT_PASSWORD)).res.statusCode).toBe(401);
    const again = await login(b1, DEFAULT_ADMIN_LOGIN, NEW_PASSWORD);
    expect(again.res.json()).toMatchObject({ defaultPassword: false });

    await b1.app.close();
    b1.db.close();
    b1.stopTickers();
    bundles.splice(bundles.indexOf(b1), 1);

    const b2 = await start(path);
    expect(b2.repos.adminUsers.count()).toBe(1);
    expect((await login(b2, DEFAULT_ADMIN_LOGIN, NEW_PASSWORD)).res.statusCode).toBe(200);
  });

  it('no built-in admin when an admin already exists (created via CLI before the first start)', async () => {
    const path = makeTestConfig().DB_PATH;
    const handle = openDb(path);
    await createAdmin(createRepos(handle.db), { login: 'ops@corp.example', password: NEW_PASSWORD });
    handle.close();
    const b = await start(path);
    expect(b.repos.adminUsers.list().map((u) => u.login)).toEqual(['ops@corp.example']);
  });

  it('CLI disable turns the built-in admin off, but never the last enabled one', async () => {
    const b = await start();
    const { session } = await login(b, DEFAULT_ADMIN_LOGIN, DEFAULT_PASSWORD);
    expect(() => disableAdmin(b.repos, DEFAULT_ADMIN_LOGIN)).toThrow(CliError);

    await createAdmin(b.repos, { login: 'owner@corp.example', password: NEW_PASSWORD });
    expect(disableAdmin(b.repos, DEFAULT_ADMIN_LOGIN)).toBeGreaterThan(0);
    expect((await adminCall(b, session!, 'GET', '/admin/api/auth/me')).statusCode).toBe(401);
    expect((await login(b, DEFAULT_ADMIN_LOGIN, DEFAULT_PASSWORD)).res.statusCode).toBe(401);
  });
});
