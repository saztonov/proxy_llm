import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { seedAdmin, loginAs, adminCall, HOST, ORIGIN_HEADERS, type AdminSession } from './helpers/admin-session.js';
import { startMockOpenRouter } from './helpers/mock-openrouter.js';

const lastAudit = (b: AppBundle, action: string) =>
  JSON.parse((b.db.db.prepare('SELECT details_json FROM admin_audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action) as { details_json: string }).details_json) as Record<string, unknown>;

describe('admin: security hardening', () => {
  let b: AppBundle;
  let s: AdminSession;

  beforeEach(async () => {
    b = await buildApp(makeTestConfig());
    await seedAdmin(b);
    s = await loginAs(b);
  });
  afterEach(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
  });

  it('a percent-encoded API path does not slip past the Origin check', async () => {
    const r = await b.app.inject({
      method: 'POST', url: '/admin/%61pi/auth/logout', cookies: s.cookies, headers: { host: HOST, origin: 'https://evil.example' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('moving a provider to another host requires re-entering its secrets', async () => {
    const created = await adminCall(b, s, 'POST', '/admin/api/providers', { name: 'gw', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-gw-secret-key-1' });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { provider: { id: number } }).provider.id;

    const moved = await adminCall(b, s, 'PATCH', `/admin/api/providers/${id}`, { baseUrl: 'https://attacker.example/v1' });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ error: { code: 'reenter_secrets' } });
    expect(b.repos.providers.get(id)!.base_url).toBe('https://llm.example.com/v1');

    const samePlace = await adminCall(b, s, 'PATCH', `/admin/api/providers/${id}`, { baseUrl: 'https://llm.example.com/api/v1' });
    expect(samePlace.statusCode).toBe(200);

    const withKey = await adminCall(b, s, 'PATCH', `/admin/api/providers/${id}`, { baseUrl: 'https://other.example/v1', apiKey: 'sk-other-secret-key-2' });
    expect(withKey.statusCode).toBe(200);
    expect(lastAudit(b, 'provider.update')).toMatchObject({ originChanged: true, apiKeyChanged: true, baseUrl: 'https://other.example' });
  });

  it('provider check does not hand back the provider response body', async () => {
    const up = await startMockOpenRouter((_q, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('internal-admin-panel secret page');
    });
    try {
      const c = await adminCall(b, s, 'POST', '/admin/api/providers', { name: 'local', baseUrl: `${up.baseUrl}/v1`, apiKey: 'sk-local-key-123456' });
      const id = (c.json() as { provider: { id: number } }).provider.id;
      const r = await adminCall(b, s, 'POST', `/admin/api/providers/${id}/test`);
      expect(r.json()).toMatchObject({ ok: false, httpStatus: 500 });
      expect(r.body).not.toContain('internal-admin-panel');
    } finally {
      await up.close();
    }
  });

  it('failed logins keep the typed text out of the audit unless the login exists', async () => {
    const typed = 'Pa55word-typed-into-login';
    const r = await b.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: ORIGIN_HEADERS, payload: { login: typed, password: 'whatever-password' } });
    expect(r.statusCode).toBe(401);
    const unknown = lastAudit(b, 'auth.login_failed');
    expect(JSON.stringify(unknown)).not.toContain(typed);
    expect(unknown).toMatchObject({ login: null, knownLogin: false });

    await b.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: ORIGIN_HEADERS, payload: { login: 'root', password: 'wrong-password-1' } });
    expect(lastAudit(b, 'auth.login_failed')).toMatchObject({ login: 'root', knownLogin: true });
  });

  it('change-password is throttled like login', async () => {
    const max = makeTestConfig().ADMIN_LOGIN_MAX_ATTEMPTS;
    const codes: number[] = [];
    for (let i = 0; i <= max; i++) {
      const r = await adminCall(b, s, 'POST', '/admin/api/auth/change-password', { current: `wrong-password-${i}`, next: 'another correct horse staple' });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, max).every((c) => c === 400)).toBe(true);
    expect(codes[max]).toBe(429);
  });
});
