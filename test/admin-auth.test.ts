import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { createAdmin } from '../src/cli/admin.js';
import { makeTestConfig } from './helpers/test-config.js';
import { ADMIN_PASSWORD, HOST, ORIGIN_HEADERS, adminCall, loginAs, seedAdmin } from './helpers/admin-session.js';

async function close(b: AppBundle): Promise<void> {
  await b.app.close();
  b.db.close();
  b.stopTickers();
}

describe('admin auth: login, cookies, CSRF', () => {
  let b: AppBundle;
  beforeEach(async () => {
    b = await buildApp(makeTestConfig());
    await seedAdmin(b);
  });
  afterEach(() => close(b));

  const login = (payload: Record<string, unknown>, headers: Record<string, string> = ORIGIN_HEADERS) =>
    b.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers, payload });

  it('sets httpOnly SameSite=Strict cookies with narrow paths and returns a CSRF token', async () => {
    const res = await login({ login: 'root', password: ADMIN_PASSWORD });
    expect(res.statusCode).toBe(200);
    const at = res.cookies.find((c) => c.name === 'admin_at');
    const rt = res.cookies.find((c) => c.name === 'admin_rt');
    expect(at).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/admin' });
    expect(rt).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/admin/api/auth' });
    expect(res.json().csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('wrong password, unknown and disabled logins get the same 401', async () => {
    const id = await createAdmin(b.repos, { login: 'off', password: ADMIN_PASSWORD });
    b.repos.adminUsers.setEnabled(id, false, Date.now());
    const results = [
      await login({ login: 'root', password: 'wrong password 123' }),
      await login({ login: 'nobody', password: 'wrong password 123' }),
      await login({ login: 'off', password: ADMIN_PASSWORD }),
    ];
    for (const r of results) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: { code: 'invalid_credentials', message: 'invalid login or password' } });
    }
  });

  it('locks a login after repeated failures', async () => {
    for (let i = 0; i < 5; i++) expect((await login({ login: 'root', password: 'nope nope nope' })).statusCode).toBe(401);
    const locked = await login({ login: 'root', password: ADMIN_PASSWORD });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.retryAfterSec).toBeGreaterThan(0);
    expect(b.repos.audit.listRecent(10).filter((e) => e.action === 'auth.login_failed')).toHaveLength(5);
  });

  it('limits login attempts per IP', async () => {
    const limited = await buildApp(makeTestConfig({ ADMIN_LOGIN_IP_MAX: 2 }));
    try {
      const go = () => limited.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: ORIGIN_HEADERS, payload: { login: 'x', password: 'y' } });
      await go();
      await go();
      const third = await go();
      expect(third.statusCode).toBe(429);
      expect(third.headers['retry-after']).toBeDefined();
    } finally {
      await close(limited);
    }
  });

  it('API needs a session; pages redirect to the login page', async () => {
    expect((await b.app.inject({ method: 'GET', url: '/admin/api/sites', headers: ORIGIN_HEADERS })).statusCode).toBe(401);
    const page = await b.app.inject({ method: 'GET', url: '/admin/sites' });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe('/admin/login?next=%2Fadmin%2Fsites');
  });

  it('mutating calls need the CSRF header, a same-origin request and JSON', async () => {
    const s = await loginAs(b);
    const body = { slug: 'it', name: 'IT' };
    const url = '/admin/api/departments';
    const noCsrf = await b.app.inject({ method: 'POST', url, cookies: s.cookies, headers: ORIGIN_HEADERS, payload: body });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf_invalid');
    expect((await adminCall(b, s, 'POST', url, body, { origin: 'http://evil.test' })).json().error.code).toBe('bad_origin');
    expect((await adminCall(b, s, 'POST', url, body, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    const noOrigin = await b.app.inject({ method: 'POST', url, cookies: s.cookies, headers: { host: HOST, 'x-csrf-token': s.csrf }, payload: body });
    expect(noOrigin.statusCode).toBe(403);
    const form = await b.app.inject({
      method: 'POST', url, cookies: s.cookies, payload: 'slug=it&name=IT',
      headers: { ...ORIGIN_HEADERS, 'x-csrf-token': s.csrf, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.statusCode).toBe(415);
    expect((await adminCall(b, s, 'POST', url, body)).statusCode).toBe(201);
  });

  it('the old /dashboard keeps its own Basic auth', async () => {
    expect((await b.app.inject({ method: 'GET', url: '/dashboard' })).statusCode).toBe(401);
    const auth = { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
    expect((await b.app.inject({ method: 'GET', url: '/dashboard', headers: auth })).statusCode).toBe(200);
  });
});
