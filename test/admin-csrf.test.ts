import { describe, it, expect } from 'vitest';
import { deriveAdminKeys } from '../src/admin/auth/keys.js';
import {
  csrfTokenFor,
  csrfValid,
  isSameOrigin,
  SAFE_METHODS,
  type OriginCheckRequest,
} from '../src/admin/auth/csrf.js';

const KEY = deriveAdminKeys('csrf-test-secret').csrf;
const OTHER_KEY = deriveAdminKeys('other-secret').csrf;

describe('csrf token', () => {
  it('is deterministic per sid and differs across sids', () => {
    const a = csrfTokenFor(KEY, 'sid-1');
    expect(csrfTokenFor(KEY, 'sid-1')).toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(csrfTokenFor(KEY, 'sid-2')).not.toBe(a);
    expect(csrfTokenFor(OTHER_KEY, 'sid-1')).not.toBe(a);
  });

  it('validates only the matching sid and key', () => {
    const token = csrfTokenFor(KEY, 'sid-1');
    expect(csrfValid(KEY, 'sid-1', token)).toBe(true);
    expect(csrfValid(KEY, 'sid-2', token)).toBe(false);
    expect(csrfValid(OTHER_KEY, 'sid-1', token)).toBe(false);
    expect(csrfValid(KEY, 'sid-1', token.slice(0, -1))).toBe(false);
    expect(csrfValid(KEY, 'sid-1', `${token}x`)).toBe(false);
    expect(csrfValid(KEY, 'sid-1', '')).toBe(false);
  });

  it('rejects anything that is not a string', () => {
    expect(csrfValid(KEY, 'sid-1', undefined)).toBe(false);
    expect(csrfValid(KEY, 'sid-1', null)).toBe(false);
    expect(csrfValid(KEY, 'sid-1', 123)).toBe(false);
    expect(csrfValid(KEY, 'sid-1', [csrfTokenFor(KEY, 'sid-1')])).toBe(false);
    expect(csrfValid(KEY, 'sid-1', { token: csrfTokenFor(KEY, 'sid-1') })).toBe(false);
  });
});

describe('isSameOrigin', () => {
  const HOST = 'admin.example.com';

  function req(method: string, headers: OriginCheckRequest['headers'] = {}, host = HOST): OriginCheckRequest {
    return { method, headers, host };
  }

  it('exposes the safe methods', () => {
    expect([...SAFE_METHODS].sort()).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });

  it('allows safe methods without any headers', () => {
    expect(isSameOrigin(req('GET'))).toBe(true);
    expect(isSameOrigin(req('HEAD'))).toBe(true);
    expect(isSameOrigin(req('OPTIONS'))).toBe(true);
    expect(isSameOrigin(req('GET', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  it('denies unsafe methods without any headers', () => {
    expect(isSameOrigin(req('POST'))).toBe(false);
    expect(isSameOrigin(req('PUT'))).toBe(false);
    expect(isSameOrigin(req('DELETE'))).toBe(false);
    expect(isSameOrigin(req('PATCH'))).toBe(false);
  });

  it('accepts an origin whose host matches', () => {
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}` }))).toBe(true);
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}/` }))).toBe(true);
    expect(isSameOrigin(req('POST', { origin: 'http://localhost:3000' }, 'localhost:3000'))).toBe(true);
  });

  it('rejects an origin from another host', () => {
    expect(isSameOrigin(req('POST', { origin: 'https://evil.example' }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}.evil.example` }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: `https://evil.example/${HOST}` }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}:8443` }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: 'http://localhost:3001' }, 'localhost:3000'))).toBe(false);
  });

  it('rejects opaque or malformed origins', () => {
    expect(isSameOrigin(req('POST', { origin: 'null' }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: '' }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: 'not a url' }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: HOST }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: 'file:///' }))).toBe(false);
  });

  it('lets sec-fetch-site override a matching origin', () => {
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}`, 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}`, 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}`, 'sec-fetch-site': 'none' }))).toBe(false);
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  it('accepts sec-fetch-site: same-origin without origin', () => {
    expect(isSameOrigin(req('POST', { 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOrigin(req('POST', { 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isSameOrigin(req('POST', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('compares hosts case-insensitively', () => {
    expect(isSameOrigin(req('POST', { origin: 'https://ADMIN.Example.COM' }))).toBe(true);
    expect(isSameOrigin(req('POST', { origin: `https://${HOST}` }, 'ADMIN.EXAMPLE.COM'))).toBe(true);
  });

  it('takes the first element of array headers', () => {
    expect(isSameOrigin(req('POST', { origin: [`https://${HOST}`, 'https://evil.example'] }))).toBe(true);
    expect(isSameOrigin(req('POST', { origin: ['https://evil.example', `https://${HOST}`] }))).toBe(false);
    expect(isSameOrigin(req('POST', { 'sec-fetch-site': ['same-origin'] }))).toBe(true);
    expect(isSameOrigin(req('POST', { 'sec-fetch-site': ['cross-site', 'same-origin'] }))).toBe(false);
  });
});
