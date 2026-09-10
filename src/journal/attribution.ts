import type { Contour } from '../storage/requests-repo.js';

/** Кому приписать запрос в журнале и ledger'е. */
export interface Attribution {
  contour: Contour;
  /** site_tokens.id или agent_tokens.id; null — токен не из БД. */
  tokenId: number | null;
  departmentId: number | null;
  employeeId: number | null;
  /** Провайдер агентского контура; у сайтов null (всегда OpenRouter). */
  providerId: number | null;
}

export function siteAttribution(tokenId: number | undefined): Attribution {
  return { contour: 'site', tokenId: tokenId ?? null, departmentId: null, employeeId: null, providerId: null };
}
