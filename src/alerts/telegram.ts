import { request as undiciRequest } from 'undici';
import type { Logger } from '../utils/logger.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export class TelegramSender {
  constructor(
    private readonly config: TelegramConfig,
    private readonly logger: Logger,
  ) {}

  enabled(): boolean {
    return Boolean(this.config.botToken && this.config.chatId);
  }

  async send(text: string): Promise<void> {
    if (!this.enabled()) {
      this.logger.warn({ text }, 'telegram alert skipped: not configured');
      return;
    }
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    try {
      const res = await undiciRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.body.text();
      if (res.statusCode >= 400) {
        this.logger.warn({ statusCode: res.statusCode, body }, 'telegram sendMessage failed');
      }
    } catch (err) {
      this.logger.warn({ err: sanitizeErrorForLog(err) }, 'telegram sendMessage threw');
    }
  }
}
