import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { revokeSessions } from '../src/cli/admin.js';
import { deriveAdminKeys } from '../src/admin/auth/keys.js';
import { signAccessToken, verifyAccessToken } from '../src/admin/auth/jwt.js';
import type { Config } from '../src/config.js';
import { makeTestConfig } from './helpers/test-config.js';
import { ADMIN_PASSWORD, ORIGIN_HEADERS, adminCall, loginAs, seedAdmin } from './helpers/admin-session.js';

async function close(b: AppBundle): Promise<void> {
  await b.app.close();
  b.db.close();
  b.stopTickers();
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('admin sessions: refresh rotation and revocation', () => {
  let config: Config;
  let b: AppBundle;
  beforeEach(async () => {
    config = makeTestConfig();
    b = await buildApp(config);
    await seedAdmin(b);
  });
  afterEach(() => close(b));

  it('expired access → refresh rotates the pair; reusing the old refresh revokes the whole session', async () => {
    const s = await loginAs(b);
    const oldRt = s.cookies.admin_rt!;
    const keys = deriveAdminKeys(config.ADMIN_JWT_SECRET);
    const claims = verifyAccessToken(keys.jwt, s.cookies.admin_at!)!;
    s.cookies.admin_at = signAccessToken(keys.jwt, { sub: claims.sub, sid: claims.sid }, 900, Date.now() - 3_600_000);
    expect((await adminCall(b, s, 'GET', '/admin/api/sites')).statusCode).toBe(401);

    const r1 = await adminCall(b, s, 'POST', '/admin/api/auth/refresh');
    expect(r1.statusCode).toBe(200);
    expect(s.cookies.admin_rt).not.toBe(oldRt);
    s.csrf = r1.json().csrf;
    expect((await adminCall(b, s, 'GET', '/admin/api/sites')).statusCode).toBe(200);

    await tick();
    const reuse = await b.app.inject({ method: 'POST', url: '/admin/api/auth/refresh', cookies: { admin_rt: oldRt }, headers: ORIGIN_HEADERS });
    expect(reuse.statusCode).toBe(401);
    expect((await adminCall(b, s, 'GET', '/admin/api/sites')).statusCode).toBe(401);
    expect(b.repos.audit.listRecent(20).map((e) => e.action)).toContain('auth.refresh_reuse');
  });

  it('within the grace window a parallel refresh gets 409 and the session survives', async () => {
    const graced = await buildApp(makeTestConfig({ ADMIN_REFRESH_REUSE_GRACE_SEC: 30 }));
    try {
      await seedAdmin(graced);
      const s = await loginAs(graced);
      const rt = s.cookies.admin_rt!;
      const first = await adminCall(graced, s, 'POST', '/admin/api/auth/refresh');
      expect(first.statusCode).toBe(200);
      const racing = await graced.app.inject({ method: 'POST', url: '/admin/api/auth/refresh', cookies: { admin_rt: rt }, headers: ORIGIN_HEADERS });
      expect(racing.statusCode).toBe(409);
      s.csrf = first.json().csrf;
      expect((await adminCall(graced, s, 'GET', '/admin/api/sites')).statusCode).toBe(200);
    } finally {
      await close(graced);
    }
  });

  it('logout, CLI revoke-sessions and a restart: revocation always wins', async () => {
    const a = await loginAs(b);
    const c = await loginAs(b);
    const aAccess = a.cookies.admin_at!;
    expect((await adminCall(b, a, 'POST', '/admin/api/auth/logout')).statusCode).toBe(204);
    expect(a.cookies.admin_at).toBeUndefined();
    expect((await b.app.inject({ method: 'GET', url: '/admin/api/sites', cookies: { admin_at: aAccess } })).statusCode).toBe(401);
    expect((await adminCall(b, c, 'GET', '/admin/api/sites')).statusCode).toBe(200);

    // Рестарт на той же БД: живая сессия остаётся живой.
    await close(b);
    b = await buildApp(config);
    expect((await adminCall(b, c, 'GET', '/admin/api/sites')).statusCode).toBe(200);
    // CLI отзывает сессии в работающем сервисе без перезапуска.
    expect(revokeSessions(b.repos, 'root')).toBeGreaterThan(0);
    expect((await adminCall(b, c, 'GET', '/admin/api/sites')).statusCode).toBe(401);
  });

  it('change-password revokes every session; only the new password works', async () => {
    const s = await loginAs(b);
    const other = await loginAs(b);
    const weak = await adminCall(b, s, 'POST', '/admin/api/auth/change-password', { current: ADMIN_PASSWORD, next: 'short' });
    expect(weak.statusCode).toBe(400);
    const wrong = await adminCall(b, s, 'POST', '/admin/api/auth/change-password', { current: 'not my password', next: 'brand new secret phrase' });
    expect(wrong.json().error.code).toBe('invalid_credentials');
    const ok = await adminCall(b, s, 'POST', '/admin/api/auth/change-password', { current: ADMIN_PASSWORD, next: 'brand new secret phrase' });
    expect(ok.statusCode).toBe(204);
    expect((await adminCall(b, other, 'GET', '/admin/api/sites')).statusCode).toBe(401);
    await expect(loginAs(b)).rejects.toThrow(/401/);
    await expect(loginAs(b, 'root', 'brand new secret phrase')).resolves.toMatchObject({ adminId: s.adminId });
  });

  it('/me returns the admin and a CSRF token bound to the session', async () => {
    const s = await loginAs(b);
    const me = await adminCall(b, s, 'GET', '/admin/api/auth/me');
    expect(me.json()).toEqual({ admin: { id: s.adminId, login: 'root', displayName: '' }, csrf: s.csrf });
  });
});
