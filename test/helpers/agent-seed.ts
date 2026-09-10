import type { AppBundle } from '../../src/app.js';
import { generateToken } from '../../src/clients/tokens.js';
import { SecretBox } from '../../src/storage/secret-box.js';
import type { UsageMode } from '../../src/storage/providers-repo.js';

export interface SeedOptions {
  baseUrl: string;
  /** Модель глобального дефолта (если у токена нет своей). */
  model?: string;
  /** Своя модель токена (провайдер тот же). */
  tokenModel?: string;
  apiKey?: string | null;
  usageMode?: UsageMode;
  providerMaxConcurrency?: number | null;
  principal?: 'employee' | 'department';
  maxConcurrency?: number | null;
  maxPending?: number | null;
  expiresAt?: number | null;
  allowedCidrs?: string[] | null;
}

export interface Seeded {
  token: string;
  tokenId: number;
  providerId: number;
  departmentId: number;
  employeeId: number | null;
}

let seq = 0;

/** Провайдер + отдел (+ сотрудник) + токен прямо через репозитории, затем reload реестра. */
export function seedAgent(bundle: AppBundle, o: SeedOptions): Seeded {
  seq += 1;
  const { repos, secrets } = bundle;
  const now = Date.now();
  const key = o.apiKey === undefined ? 'sk-provider-test-key' : o.apiKey;
  const providerId = repos.providers.create({
    name: `prov-${seq}`,
    base_url: o.baseUrl,
    api_key_enc: key === null ? null : secrets.seal(key),
    api_key_fp: key === null ? null : SecretBox.fingerprint(key),
    extra_headers_enc: null,
    usage_mode: o.usageMode ?? 'auto',
    max_concurrency: o.providerMaxConcurrency ?? null,
  }, now);
  const asEmployee = (o.principal ?? 'employee') === 'employee';
  const limits = { max_concurrency: o.maxConcurrency ?? null, max_pending: o.maxPending ?? null };
  const departmentId = repos.directory.createDepartment(
    { slug: `dept${seq}`, name: `Отдел ${seq}`, ...(asEmployee ? { max_concurrency: null, max_pending: null } : limits) }, now);
  const employeeId = asEmployee
    ? repos.directory.createEmployee({ login: `emp${seq}`, display_name: `Сотрудник ${seq}`, email: null, department_id: departmentId, ...limits }, now)
    : null;
  if (o.tokenModel === undefined) {
    repos.settings.setAgentDefaults({ providerId, model: o.model ?? 'target/model', maxConcurrency: null, maxPending: null }, now);
  }
  const t = generateToken('agent');
  const tokenId = repos.agentTokens.issue({
    token_sha256: t.sha256,
    token_prefix: t.prefix,
    label: 'test',
    principal_type: asEmployee ? 'employee' : 'department',
    department_id: asEmployee ? null : departmentId,
    employee_id: employeeId,
    provider_id: o.tokenModel === undefined ? null : providerId,
    model: o.tokenModel ?? null,
    allowed_cidrs_json: o.allowedCidrs ? JSON.stringify(o.allowedCidrs) : null,
    expires_at: o.expiresAt ?? null,
  }, now);
  bundle.agentRegistry.reload();
  return { token: t.plaintext, tokenId, providerId, departmentId, employeeId };
}
