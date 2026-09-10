import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import type { Logger } from '../utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
/** src/admin → src/views/admin (в dist — dist/views/admin, туда их копирует copy-assets). */
export const ADMIN_VIEWS = resolve(here, '..', 'views', 'admin');

export type PageName =
  | 'login' | 'home' | 'sites' | 'directory' | 'providers' | 'agent-tokens'
  | 'settings' | 'stats' | 'requests' | 'audit' | '404';

export interface StaticAsset {
  body: Buffer;
  type: string;
}

const ASSET_TYPES: Record<string, string> = {
  'admin.css': 'text/css; charset=utf-8',
  'admin.js': 'text/javascript; charset=utf-8',
};

/**
 * Шаблоны читает Eta (с кэшем в проде); статика — два файла из памяти по белому списку,
 * без обхода путей и без @fastify/static. Версия ассетов — хэш содержимого: браузер кэширует
 * их навсегда, а после деплоя получает новые.
 */
export class AdminRenderer {
  readonly assets = new Map<string, StaticAsset>();
  readonly assetVersion: string;
  private readonly eta: Eta;

  constructor(cache: boolean, logger: Logger) {
    this.eta = new Eta({ views: ADMIN_VIEWS, autoEscape: true, cache, defaultExtension: '.eta' });
    const hash = createHash('sha256');
    for (const [name, type] of Object.entries(ASSET_TYPES)) {
      try {
        const body = readFileSync(join(ADMIN_VIEWS, 'static', name));
        this.assets.set(name, { body, type });
        hash.update(body);
      } catch {
        logger.warn({ asset: name }, 'admin static asset is missing');
      }
    }
    this.assetVersion = hash.digest('hex').slice(0, 12);
  }

  render(page: PageName, data: { title: string; next?: string }): string {
    return this.eta.render(page, { ...data, page, assetVersion: this.assetVersion });
  }
}
