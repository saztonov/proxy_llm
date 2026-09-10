import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { HOST, loginAs, seedAdmin } from './helpers/admin-session.js';

const PAGES = [
  '/admin', '/admin/sites', '/admin/directory', '/admin/providers', '/admin/agent-tokens',
  '/admin/settings', '/admin/stats', '/admin/requests', '/admin/audit',
];

/** CSP запрещает inline-код; шаблоны не должны на него полагаться. */
function expectNoInlineCode(html: string): void {
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(html).not.toMatch(/<style/i);
  expect(html).not.toMatch(/\sstyle=/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
}

describe('admin pages', () => {
  let b: AppBundle;
  beforeAll(async () => {
    b = await buildApp(makeTestConfig());
    await seedAdmin(b);
  });
  afterAll(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
  });

  it('login page renders without inline code and with a safe next', async () => {
    const r = await b.app.inject({ method: 'GET', url: '/admin/login?next=//evil.example' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('data-page="login"');
    expect(r.body).toContain('data-next="/admin"');
    expectNoInlineCode(r.body);
  });

  it('every page renders for a logged-in admin', async () => {
    const s = await loginAs(b);
    for (const url of PAGES) {
      const r = await b.app.inject({ method: 'GET', url, cookies: s.cookies, headers: { host: HOST } });
      expect(r.statusCode, url).toBe(200);
      expectNoInlineCode(r.body);
      expect(r.body).toMatch(/\/admin\/static\/admin\.js\?v=[0-9a-f]{12}/);
    }
  });

  it('static assets: versioned URLs are immutable, anything else is 404', async () => {
    const page = await b.app.inject({ method: 'GET', url: '/admin/login' });
    const v = /admin\.js\?v=([0-9a-f]{12})/.exec(page.body)![1];
    const js = await b.app.inject({ method: 'GET', url: `/admin/static/admin.js?v=${v}` });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.headers['cache-control']).toContain('immutable');
    expect((await b.app.inject({ method: 'GET', url: '/admin/static/admin.css' })).headers['cache-control']).toBe('no-cache');
    expect((await b.app.inject({ method: 'GET', url: '/admin/static/..%2Fplugin.js' })).statusCode).toBe(404);
    expect((await b.app.inject({ method: 'GET', url: '/admin/static/secret.txt' })).statusCode).toBe(404);
  });

  it('unknown admin pages get 404 without exposing anything', async () => {
    const r = await b.app.inject({ method: 'GET', url: '/admin/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
