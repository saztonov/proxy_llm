import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { openDb } from '../storage/db.js';
import { createRepos, type Repos } from '../storage/repos.js';
import { SecretBox } from '../storage/secret-box.js';
import { ConflictError } from '../storage/errors.js';
import type { UsageMode } from '../storage/providers-repo.js';
import { hashPassword, validateNewPassword } from '../admin/auth/password.js';
import { generateToken } from '../clients/tokens.js';
import { readClientsFile } from '../clients/registry.js';
import { importClientEntries, type ImportCounts } from '../clients/site-bootstrap.js';
import { validateCidr } from '../utils/cidr.js';
import { validateProviderUrl, normalizeProviderUrl } from '../upstream/provider-url.js';

/**
 * CLI администратора: то, что нельзя или рано делать через веб — первый админ, сброс пароля,
 * отзыв сессий, заведение провайдера и токенов до готовности админки, импорт clients.json,
 * ротация ключа шифрования. Секреты — только через stdin или --generate, никогда в argv
 * (argv виден всем в `ps`).
 *
 * Работает прямо с БД. Работающий сервис перечитывает реестры сам в течение ~5 с (отметка
 * settings.registry_generation) или сразу по `systemctl kill -s HUP proxy_llm`.
 * Сессии админов проверяются по БД на каждом запросе,
 * поэтому revoke-sessions и reset-password действуют сразу.
 */

export class CliError extends Error {
  override readonly name = 'CliError';
}

const ADMIN_LOGIN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const EMPLOYEE_LOGIN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USAGE_MODES: readonly UsageMode[] = ['auto', 'openrouter', 'stream_options', 'none'];

function need(v: string | undefined, name: string): string {
  if (v === undefined || v.trim() === '') throw new CliError(`--${name} is required`);
  return v.trim();
}

export async function createAdmin(repos: Repos, input: { login: string; password: string; displayName?: string }, now = Date.now()): Promise<number> {
  const login = input.login.trim().toLowerCase();
  if (!ADMIN_LOGIN.test(login)) throw new CliError('login: 3-32 chars of a-z 0-9 . _ -');
  const err = validateNewPassword(input.password);
  if (err) throw new CliError(err);
  const hash = await hashPassword(input.password);
  return repos.adminUsers.create({ login, password_hash: hash, display_name: input.displayName ?? '' }, now);
}

/** Новый пароль и отзыв всех сессий этого админа. Возвращает число отозванных сессий. */
export async function resetPassword(repos: Repos, input: { login: string; password: string }, now = Date.now()): Promise<number> {
  const user = repos.adminUsers.getByLogin(input.login.trim());
  if (!user) throw new CliError(`admin "${input.login}" not found`);
  const err = validateNewPassword(input.password);
  if (err) throw new CliError(err);
  repos.adminUsers.setPassword(user.id, await hashPassword(input.password), now);
  return repos.adminSessions.revokeAllForAdmin(user.id, now, 'password_reset').length;
}

export function revokeSessions(repos: Repos, login: string | undefined, now = Date.now()): number {
  const users = login ? [repos.adminUsers.getByLogin(login.trim())] : repos.adminUsers.list();
  if (login && !users[0]) throw new CliError(`admin "${login}" not found`);
  let n = 0;
  for (const u of users) if (u) n += repos.adminSessions.revokeAllForAdmin(u.id, now, 'cli_revoke').length;
  return n;
}

export function addProvider(repos: Repos, secrets: SecretBox, input: {
  name: string; baseUrl: string; apiKey: string | null; usageMode?: string; maxConcurrency?: number | null; allowInsecure?: boolean;
}, now = Date.now()): number {
  const baseUrl = normalizeProviderUrl(input.baseUrl);
  const err = validateProviderUrl(baseUrl, input.allowInsecure ?? false);
  if (err) throw new CliError(err);
  const usageMode = (input.usageMode ?? 'auto') as UsageMode;
  if (!USAGE_MODES.includes(usageMode)) throw new CliError(`--usage-mode: one of ${USAGE_MODES.join(', ')}`);
  const key = input.apiKey;
  return repos.providers.create({
    name: input.name.trim(),
    base_url: baseUrl,
    api_key_enc: key ? secrets.seal(key) : null,
    api_key_fp: key ? SecretBox.fingerprint(key) : null,
    extra_headers_enc: null,
    usage_mode: usageMode,
    max_concurrency: input.maxConcurrency ?? null,
  }, now);
}

export function addDepartment(repos: Repos, input: { slug: string; name: string }, now = Date.now()): number {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG.test(slug)) throw new CliError('department slug: 1-32 chars of a-z 0-9 _ -');
  return repos.directory.createDepartment({ slug, name: input.name.trim(), max_concurrency: null, max_pending: null }, now);
}

export function addEmployee(repos: Repos, input: { login: string; name: string; departmentSlug: string; email?: string | null }, now = Date.now()): number {
  const login = input.login.trim().toLowerCase();
  if (!EMPLOYEE_LOGIN.test(login)) throw new CliError('employee login: 1-64 chars of a-z 0-9 . _ -');
  const dept = repos.directory.getDepartmentBySlug(input.departmentSlug.trim());
  if (!dept) throw new CliError(`department "${input.departmentSlug}" not found`);
  return repos.directory.createEmployee({
    login, display_name: input.name.trim(), email: input.email ?? null, department_id: dept.id, max_concurrency: null, max_pending: null,
  }, now);
}

function providerIdByName(repos: Repos, name: string): number {
  const p = repos.providers.list().find((x) => x.name === name);
  if (!p) throw new CliError(`provider "${name}" not found`);
  if (p.enabled !== 1) throw new CliError(`provider "${name}" is disabled`);
  return p.id;
}

export interface IssueInput {
  employeeLogin?: string;
  departmentSlug?: string;
  label?: string;
  providerName?: string;
  model?: string;
  expiresAt?: number | null;
  allowedCidrs?: string[];
}

/** Выпуск агентского токена. Открытый текст возвращается один раз; в БД — только sha256. */
export function issueAgentToken(repos: Repos, input: IssueInput, now = Date.now()): { id: number; token: string; prefix: string } {
  if (Boolean(input.employeeLogin) === Boolean(input.departmentSlug)) {
    throw new CliError('specify exactly one of --employee or --department');
  }
  if (Boolean(input.providerName) !== Boolean(input.model)) {
    throw new CliError('--provider and --model go together (or omit both to use the global default)');
  }
  let departmentId: number | null = null;
  let employeeId: number | null = null;
  if (input.employeeLogin) {
    const e = repos.directory.getEmployeeByLogin(input.employeeLogin);
    if (!e) throw new CliError(`employee "${input.employeeLogin}" not found`);
    employeeId = e.id;
  } else {
    const d = repos.directory.getDepartmentBySlug(input.departmentSlug!);
    if (!d) throw new CliError(`department "${input.departmentSlug}" not found`);
    departmentId = d.id;
  }
  for (const c of input.allowedCidrs ?? []) {
    const err = validateCidr(c);
    if (err) throw new CliError(err);
  }
  const t = generateToken('agent');
  const id = repos.agentTokens.issue({
    token_sha256: t.sha256,
    token_prefix: t.prefix,
    label: input.label ?? '',
    principal_type: employeeId !== null ? 'employee' : 'department',
    department_id: departmentId,
    employee_id: employeeId,
    provider_id: input.providerName ? providerIdByName(repos, input.providerName) : null,
    model: input.model ?? null,
    allowed_cidrs_json: input.allowedCidrs && input.allowedCidrs.length > 0 ? JSON.stringify(input.allowedCidrs) : null,
    expires_at: input.expiresAt ?? null,
  }, now);
  return { id, token: t.plaintext, prefix: t.prefix };
}

export function setAgentDefault(repos: Repos, input: { providerName: string; model: string }, now = Date.now()): void {
  const cur = repos.settings.agentDefaults();
  repos.settings.setAgentDefaults({ ...cur, providerId: providerIdByName(repos, input.providerName), model: input.model.trim() }, now);
}

/** Повторный импорт clients.json по явной команде (bootstrap сервиса делает его один раз). */
export function importClientsFile(db: Database.Database, repos: Repos, secrets: SecretBox, path: string, now = Date.now()): ImportCounts {
  const file = readClientsFile({ CLIENTS_CONFIG_PATH: path } as Config);
  if (!file) throw new CliError(`file not found: ${path}`);
  return db.transaction(() => importClientEntries({ ...repos, secrets }, file.entries, file.path, now))();
}

const SEALED_COLUMNS: ReadonlyArray<[table: string, key: string, column: string]> = [
  ['site_clients', 'client_id', 'openrouter_api_key_enc'],
  ['providers', 'id', 'api_key_enc'],
  ['providers', 'id', 'extra_headers_enc'],
];

/**
 * Ротация SECRETS_ENCRYPTION_KEY: перешифровать все значения в одной транзакции. Если хоть одно
 * не открывается старым ключом — не меняется ничего (иначе часть секретов стала бы нечитаемой).
 */
export function rekey(db: Database.Database, oldBox: SecretBox, newBox: SecretBox): number {
  return db.transaction(() => {
    let n = 0;
    for (const [table, key, column] of SEALED_COLUMNS) {
      const rows = db.prepare(`SELECT ${key} AS k, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all() as { k: unknown; v: string }[];
      const upd = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`);
      for (const r of rows) {
        upd.run(newBox.reseal(r.v, oldBox), r.k);
        n += 1;
      }
    }
    return n;
  })();
}

const USAGE = `Usage: node dist/cli/admin.js <command> [options]   (env: DB_PATH, SECRETS_ENCRYPTION_KEY)

  create --login <l> (--password-stdin | --generate) [--name <n>]
  reset-password --login <l> (--password-stdin | --generate)
  revoke-sessions [--login <l>]
  provider add --name <n> --base-url <url> (--key-stdin | --no-key) [--usage-mode auto|openrouter|stream_options|none]
               [--max-concurrency <n>] [--allow-insecure]
  provider list
  department add --slug <s> --name <n>
  employee add --login <l> --name <n> --department <slug> [--email <e>]
  agent-token issue (--employee <login> | --department <slug>) [--label <x>] [--provider <name> --model <m>]
                    [--expires-days <d>] [--cidr <net> ...]
  agent-token list
  agent-token revoke --id <n>
  settings set-default --provider <name> --model <m>
  import-clients --file <path>
  rekey                         (new key from stdin; old key from SECRETS_ENCRYPTION_KEY)`;

const OPTIONS = {
  login: { type: 'string' }, name: { type: 'string' }, 'password-stdin': { type: 'boolean' }, generate: { type: 'boolean' },
  'base-url': { type: 'string' }, 'key-stdin': { type: 'boolean' }, 'no-key': { type: 'boolean' }, 'usage-mode': { type: 'string' },
  'max-concurrency': { type: 'string' }, 'allow-insecure': { type: 'boolean' }, slug: { type: 'string' }, department: { type: 'string' },
  employee: { type: 'string' }, email: { type: 'string' }, label: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
  'expires-days': { type: 'string' }, cidr: { type: 'string', multiple: true }, id: { type: 'string' }, file: { type: 'string' },
} as const;

function readStdinSecret(): string {
  const v = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!v) throw new CliError('empty value on stdin');
  return v;
}

const APPLY_HINT = 'The running service picks this up within ~5 s (immediately: systemctl kill -s HUP proxy_llm).';

/** Целое в диапазоне или CliError: NaN не должен молча превращаться в «бессрочный». */
export function intOption(value: string | undefined, name: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (!/^\d+$/.test(v)) throw new CliError(`--${name} must be a whole number`);
  const n = Number(v);
  if (n < min || n > max) throw new CliError(`--${name} must be between ${min} and ${max}`);
  return n;
}

export async function main(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, sub] = positionals;
  if (!cmd) {
    out(USAGE);
    return 2;
  }
  const handle = openDb(process.env.DB_PATH ?? '/var/lib/proxy_llm/prod.db');
  const repos = createRepos(handle.db);
  // Отметка для registry-watcher работающего сервиса: он перечитает реестры за несколько секунд.
  const applied = (): void => {
    repos.settings.bumpRegistryGeneration(Date.now());
    err(APPLY_HINT);
  };
  const secrets = (): SecretBox => {
    const k = process.env.SECRETS_ENCRYPTION_KEY;
    if (!k) throw new CliError('SECRETS_ENCRYPTION_KEY is not set');
    return new SecretBox(k);
  };
  const password = (): string => {
    if (o.generate) {
      const p = randomBytes(18).toString('base64url');
      err('Generated password (shown once):');
      out(p);
      return p;
    }
    if (o['password-stdin']) return readStdinSecret();
    throw new CliError('use --password-stdin or --generate (never pass passwords in argv)');
  };
  try {
    switch (`${cmd}${sub ? ' ' + sub : ''}`) {
      case 'create':
        out(`admin id ${await createAdmin(repos, { login: need(o.login, 'login'), password: password(), displayName: o.name ?? '' })}`);
        return 0;
      case 'reset-password':
        out(`sessions revoked: ${await resetPassword(repos, { login: need(o.login, 'login'), password: password() })}`);
        return 0;
      case 'revoke-sessions':
        out(`sessions revoked: ${revokeSessions(repos, o.login)}`);
        return 0;
      case 'provider add': {
        if (!o['key-stdin'] && !o['no-key']) throw new CliError('use --key-stdin (or --no-key for a keyless local provider)');
        const id = addProvider(repos, secrets(), {
          name: need(o.name, 'name'),
          baseUrl: need(o['base-url'], 'base-url'),
          apiKey: o['key-stdin'] ? readStdinSecret() : null,
          ...(o['usage-mode'] ? { usageMode: o['usage-mode'] } : {}),
          maxConcurrency: intOption(o['max-concurrency'], 'max-concurrency', 1, 200),
          allowInsecure: o['allow-insecure'] === true,
        });
        out(`provider id ${id}`);
        applied();
        return 0;
      }
      case 'provider list':
        for (const p of repos.providers.list()) {
          out(`${p.id}\t${p.name}\t${p.base_url}\t${p.enabled ? 'enabled' : 'disabled'}\tkey:${p.api_key_fp ?? '—'}`);
        }
        return 0;
      case 'department add':
        out(`department id ${addDepartment(repos, { slug: need(o.slug, 'slug'), name: need(o.name, 'name') })}`);
        applied();
        return 0;
      case 'employee add':
        out(`employee id ${addEmployee(repos, {
          login: need(o.login, 'login'), name: need(o.name, 'name'), departmentSlug: need(o.department, 'department'), email: o.email ?? null,
        })}`);
        applied();
        return 0;
      case 'agent-token issue': {
        const days = intOption(o['expires-days'], 'expires-days', 1, 3650);
        const t = issueAgentToken(repos, {
          ...(o.employee ? { employeeLogin: o.employee } : {}),
          ...(o.department ? { departmentSlug: o.department } : {}),
          ...(o.label ? { label: o.label } : {}),
          ...(o.provider ? { providerName: o.provider } : {}),
          ...(o.model ? { model: o.model } : {}),
          expiresAt: days ? Date.now() + days * 86_400_000 : null,
          ...(o.cidr ? { allowedCidrs: o.cidr } : {}),
        });
        err(`Token id ${t.id} (${t.prefix}…). Shown once — hand it over via a secure channel:`);
        out(t.token);
        applied();
        return 0;
      }
      case 'agent-token list':
        for (const t of repos.agentTokens.list({})) {
          const owner = t.employee_login ?? t.department_name ?? '?';
          out(`${t.id}\t${t.token_prefix}…\t${owner}\t${t.provider_name ?? 'default'}/${t.model ?? 'default'}\t${t.label}`);
        }
        return 0;
      case 'agent-token revoke':
        out(repos.agentTokens.revoke(intOption(need(o.id, 'id'), 'id', 1, Number.MAX_SAFE_INTEGER)!, Date.now()) ? 'revoked' : 'not found or already revoked');
        applied();
        return 0;
      case 'settings set-default':
        setAgentDefault(repos, { providerName: need(o.provider, 'provider'), model: need(o.model, 'model') });
        out('ok');
        applied();
        return 0;
      case 'import-clients':
        out(JSON.stringify(importClientsFile(handle.db, repos, secrets(), need(o.file, 'file'))));
        applied();
        return 0;
      case 'rekey': {
        const n = rekey(handle.db, secrets(), new SecretBox(readStdinSecret()));
        out(`re-encrypted values: ${n}. Now put the new key into SECRETS_ENCRYPTION_KEY and restart the service.`);
        return 0;
      }
      default:
        out(USAGE);
        return 2;
    }
  } finally {
    handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      const known =
        e instanceof CliError || e instanceof ConflictError || (e as { code?: string } | null)?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
      console.error(known ? `error: ${(e as Error).message}` : e);
      process.exit(1);
    },
  );
}
