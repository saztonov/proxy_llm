const SECRET_PATTERNS: RegExp[] = [
  /sk-or-[a-zA-Z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._\-]+/g,
  /([A-Fa-f0-9]{32,})/g,
];

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

export function removeSecrets(value: string): string {
  let out = value;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

export function sanitizeForLog(value: string, max = 500): string {
  return truncate(removeSecrets(value), max);
}
