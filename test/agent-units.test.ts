import { describe, expect, it } from 'vitest';
import { buildAgentPayload } from '../src/upstream/agent-payload.js';
import { buildBlockList, ipAllowed, validateCidr, normalizeIp } from '../src/utils/cidr.js';
import { WindowRateLimiter, AuthFailureMonitor } from '../src/agent/limiters.js';
import { validateExtraHeader, sanitizeExtraHeaders } from '../src/upstream/provider-headers.js';
import { providerKind } from '../src/clients/agent-registry.js';
import { agentResponseHeaders } from '../src/upstream/filter-response-headers.js';

describe('buildAgentPayload', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  it('forces the target model and drops routing fields', () => {
    const r = buildAgentPayload({ model: 'x'.repeat(300), models: ['a'], provider: {}, route: 'fallback', preset: 'p', messages: msgs }, { model: 'm', usageMode: 'none' });
    expect(r.payload).toEqual({ model: 'm', messages: msgs });
    expect(r.modelAsked).toHaveLength(128);
    expect(r.stream).toBe(false);
  });
  it('requests usage in streams according to the provider mode, merging client options', () => {
    expect(buildAgentPayload({ stream: true, messages: msgs }, { model: 'm', usageMode: 'openrouter' }).payload.usage).toEqual({ include: true });
    const so = buildAgentPayload({ stream: true, stream_options: { foo: 1 }, messages: msgs }, { model: 'm', usageMode: 'stream_options' });
    expect(so.payload.stream_options).toEqual({ foo: 1, include_usage: true });
    expect(buildAgentPayload({ stream: true, messages: msgs }, { model: 'm', usageMode: 'none' }).payload).not.toHaveProperty('stream_options');
  });
  it('removes stream_options from non-stream requests (OpenAI rejects them)', () => {
    expect(buildAgentPayload({ stream_options: { include_usage: true }, messages: msgs }, { model: 'm', usageMode: 'stream_options' }).payload).not.toHaveProperty('stream_options');
  });
});

describe('cidr', () => {
  it('validates and matches IPv4, IPv6 and IPv4-mapped addresses', () => {
    expect(validateCidr('10.0.0.0/8')).toBeNull();
    expect(validateCidr('10.0.0.0/33')).not.toBeNull();
    expect(validateCidr('fd00::/8')).toBeNull();
    expect(validateCidr('nope')).not.toBeNull();
    const bl = buildBlockList(['10.0.0.0/8', '192.168.1.5', 'fd00::/8']);
    expect(ipAllowed(bl, '10.2.3.4')).toBe(true);
    expect(ipAllowed(bl, '::ffff:10.2.3.4')).toBe(true);
    expect(ipAllowed(bl, '192.168.1.6')).toBe(false);
    expect(ipAllowed(bl, 'fd00::1')).toBe(true);
    expect(ipAllowed(bl, 'garbage')).toBe(false);
    expect(normalizeIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('limiters', () => {
  it('window rate limiter resets after the window and isolates keys', () => {
    let now = 0;
    const rl = new WindowRateLimiter(2, 1000, () => now);
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(true);
    const third = rl.hit('a');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBe(1);
    expect(rl.hit('b').allowed).toBe(true);
    now = 1000;
    expect(rl.hit('a').allowed).toBe(true);
  });
  it('auth failure monitor counts within the window, ranks IPs and throttles alerts', () => {
    let now = 0;
    const m = new AuthFailureMonitor(1000, () => now, 60_000);
    m.record('1.1.1.1');
    m.record('1.1.1.1');
    expect(m.record('2.2.2.2')).toBe(3);
    expect(m.topIps()).toEqual(['1.1.1.1×2', '2.2.2.2×1']);
    expect(m.shouldNotify()).toBe(true);
    expect(m.shouldNotify()).toBe(false);
    now = 2000;
    expect(m.record('3.3.3.3')).toBe(1);
  });
  it('auth failure monitor is bounded under a flood', () => {
    const m = new AuthFailureMonitor(60_000, () => 0);
    let last = 0;
    for (let i = 0; i < AuthFailureMonitor.MAX_EVENTS + 500; i++) last = m.record(`10.0.${i % 250}.1`);
    expect(last).toBe(AuthFailureMonitor.MAX_EVENTS);
  });
});

describe('provider headers and kind', () => {
  it('refuses to override managed headers and header injection', () => {
    expect(validateExtraHeader('OpenAI-Organization', 'org-1')).toBeNull();
    expect(validateExtraHeader('Authorization', 'x')).not.toBeNull();
    expect(validateExtraHeader('X-Evil', 'a\r\nInjected: 1')).not.toBeNull();
    expect(sanitizeExtraHeaders({ 'OpenAI-Organization': 'org-1', authorization: 'x', 'x-bad': 5 })).toEqual({ 'OpenAI-Organization': 'org-1' });
  });
  it('detects OpenRouter by host only', () => {
    expect(providerKind('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(providerKind('https://evil.example/openrouter.ai')).toBe('generic');
    expect(providerKind('not a url')).toBe('generic');
  });
  it('agent response headers drop provider rate-limit and auth headers', () => {
    const h = agentResponseHeaders({ 'content-type': 'application/json', 'retry-after': '3', 'x-ratelimit-remaining': '1', 'www-authenticate': 'Bearer' }, 'rid', 'up-1', 'generic');
    expect(h).toEqual({ 'content-type': 'application/json', 'x-proxy-request-id': 'rid', 'retry-after': '3', 'x-upstream-request-id': 'up-1' });
  });
});
