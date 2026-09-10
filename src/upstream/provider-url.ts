import { BlockList, isIP } from 'node:net';

/** Адреса, куда допустим http:// (локальная Ollama, провайдер в своей сети) — и только с флагом. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;
  const family = isIP(host);
  if (family === 0) return false;
  return PRIVATE.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * base URL провайдера задаёт админ, но ключ провайдера уйдёт именно туда — поэтому:
 * только https; http — лишь на loopback/частный адрес и только с ADMIN_ALLOW_INSECURE_PROVIDERS;
 * без логина в URL, query и фрагмента (запрос строится как `${base}/chat/completions`).
 * Редиректы клиент не выполняет (undici.request), так что уйти на другой хост ключ не может.
 * Возвращает текст ошибки или null.
 */
export function validateProviderUrl(raw: string, allowInsecure: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'base URL is not a valid URL';
  }
  if (u.username || u.password) return 'base URL must not contain credentials';
  if (u.search || u.hash) return 'base URL must not contain a query or fragment';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && allowInsecure && isPrivateHost(u.hostname)) return null;
  return 'base URL must use https:// (http:// only for loopback or private hosts with ADMIN_ALLOW_INSECURE_PROVIDERS=true)';
}

export function normalizeProviderUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}
