import type { FastifyReply } from 'fastify';

export type OpenAIErrorType =
  | 'invalid_request_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'server_error';

export interface OpenAIErrorBody {
  error: { message: string; type: OpenAIErrorType; param: string | null; code: string | null };
}

/**
 * Формат ошибок агентского контура — как у OpenAI API: SDK и IDE (Cursor, Continue, Cline)
 * показывают пользователю `error.message`. Контур сайтов сохраняет свой {error:{code,message}}.
 */
export function openaiError(
  code: string,
  message: string,
  type: OpenAIErrorType = 'invalid_request_error',
  param: string | null = null,
): OpenAIErrorBody {
  return { error: { message, type, param, code } };
}

/** Для runChatAttempts: тело ошибки, сформированной самим прокси (таймаут, сеть, лимит). */
export function openaiErrorBody(code: string, message: string): string {
  return JSON.stringify(openaiError(code, message, 'server_error'));
}

function typeForStatus(status: number): OpenAIErrorType {
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export function sendOpenAIError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  param: string | null = null,
): void {
  reply
    .code(status)
    .header('content-type', 'application/json; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(openaiError(code, message, typeForStatus(status), param));
}

/**
 * Ошибка после того, как 200 и часть стрима уже ушли клиенту: другого способа сообщить о ней
 * нет. OpenAI SDK на error-объекте в чанке поднимает APIError, IDE показывают message.
 */
export function sseErrorEvent(code: string, message: string): string {
  return `data: ${JSON.stringify(openaiError(code, message, 'server_error'))}\n\ndata: [DONE]\n\n`;
}
