import type { Classification } from './retry.js';
import type { FilteredHeaders } from './filter-response-headers.js';
import type { NormalizedUsage } from './usage.js';

/** Итог одной попытки: классификация non-stream ответа либо исход стрима агентского контура. */
export type AttemptClassification =
  | Classification['kind']
  | 'client_aborted'
  | 'stream_upstream_error'
  | 'stream_incomplete';

/**
 * Наблюдение за одной фактической попыткой обращения к провайдеру.
 *
 * Отдаётся колбэком сразу после попытки — ДО решения о ретрае, чтобы оплаченная, но
 * отброшенная попытка не потерялась (в том числе при падении процесса). Клиент остаётся
 * storage-agnostic: писать наблюдение в БД — дело вызывающего.
 */
export interface AttemptObservation {
  attemptNo: number;
  tsStarted: number;
  tsCompleted: number;
  httpStatus: number | null;
  classification: AttemptClassification;
  modelUsed?: string;
  upstreamId?: string;
  usage?: NormalizedUsage;
  /** 'response' — usage.cost получен; 'missing' — тело не разобрано либо cost не пришёл. */
  usageSource: 'response' | 'missing';
}

export interface ProxyResult {
  statusCode: number;
  headers: FilteredHeaders;
  bodyText: string;
  usage?: NormalizedUsage;
  modelUsed?: string;
  upstreamId?: string;
  classification: Classification['kind'];
  /** best-effort: 1=fallback, 0=primary, null=неоднозначно */
  fallbackUsed: number | null;
  attemptCount: number;
  errorCode?: string;
  errorMsg?: string;
  retryAfterSeconds?: number;
}
