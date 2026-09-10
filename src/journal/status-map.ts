import type { RequestStatus } from '../storage/requests-repo.js';
import type { AttemptClassification } from '../upstream/types.js';

/** Классификация попытки/стрима → статус строки журнала requests. */
export function mapStatus(classification: AttemptClassification): RequestStatus {
  switch (classification) {
    case 'success':
      return 'success';
    case 'body_level_error':
      return 'body_level_error';
    case 'malformed_success':
      return 'malformed_success';
    case 'upstream_response_too_large':
      return 'upstream_response_too_large';
    case 'network_error':
      return 'timeout';
    case 'client_aborted':
      return 'client_aborted';
    case 'stream_upstream_error':
      return 'stream_upstream_error';
    case 'stream_incomplete':
      return 'stream_incomplete';
    case 'upstream_error':
    default:
      return 'upstream_error';
  }
}
