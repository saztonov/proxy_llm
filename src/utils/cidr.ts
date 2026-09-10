import { BlockList, isIP } from 'node:net';

/** '::ffff:10.0.0.1' → '10.0.0.1': так Node представляет IPv4-клиента на dual-stack сокете. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

/** Ошибка или null. Принимает адрес ('10.1.2.3') и подсеть ('10.0.0.0/8', 'fd00::/8'). */
export function validateCidr(entry: string): string | null {
  const [addr, bits, extra] = entry.trim().split('/');
  if (extra !== undefined || !addr) return `invalid CIDR: ${entry}`;
  const family = isIP(addr);
  if (family === 0) return `invalid IP address: ${entry}`;
  if (bits === undefined) return null;
  const n = Number(bits);
  const max = family === 4 ? 32 : 128;
  if (!/^\d+$/.test(bits) || n > max) return `invalid prefix length: ${entry}`;
  return null;
}

export function buildBlockList(entries: readonly string[]): BlockList {
  const bl = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    const err = validateCidr(entry);
    if (err) throw new Error(err);
    const [addr, bits] = entry.split('/') as [string, string | undefined];
    const type = isIP(addr) === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) bl.addAddress(addr, type);
    else bl.addSubnet(addr, Number(bits), type);
  }
  return bl;
}

export function ipAllowed(bl: BlockList, ip: string): boolean {
  const addr = normalizeIp(ip);
  const family = isIP(addr);
  if (family === 0) return false;
  return bl.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}
