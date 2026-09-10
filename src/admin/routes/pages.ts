import type { FastifyInstance } from 'fastify';
import type { AdminCtx } from '../ctx.js';
import type { PageName } from '../render.js';
import { safeNext } from '../auth/hooks.js';
import { sendError } from '../validation.js';

const PAGES: ReadonlyArray<[path: string, page: PageName, title: string]> = [
  ['/', 'home', 'Сводка'],
  ['/sites', 'sites', 'Сайты'],
  ['/directory', 'directory', 'Справочник'],
  ['/providers', 'providers', 'Провайдеры'],
  ['/agent-tokens', 'agent-tokens', 'Агентские ключи'],
  ['/settings', 'settings', 'Настройки'],
  ['/stats', 'stats', 'Статистика'],
  ['/requests', 'requests', 'Запросы'],
  ['/audit', 'audit', 'Аудит'],
];

export async function registerPageRoutes(app: FastifyInstance, ctx: AdminCtx): Promise<void> {
  // Статика — только из белого списка в памяти; с ?v=<версия> кэшируется навсегда.
  app.get('/static/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const asset = ctx.renderer.assets.get(file);
    if (!asset) return sendError(reply, 404, 'not_found', 'not found');
    const v = (req.query as { v?: unknown }).v;
    reply
      .header('content-type', asset.type)
      .header('etag', `"${ctx.renderer.assetVersion}"`)
      .header('cache-control', v === ctx.renderer.assetVersion ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(asset.body);
  });

  app.get('/login', async (req, reply) => {
    const next = safeNext((req.query as { next?: unknown }).next);
    reply.type('text/html; charset=utf-8').send(ctx.renderer.render('login', { title: 'Вход', next }));
  });

  await app.register(async (pages) => {
    pages.addHook('onRequest', ctx.hooks.requirePage);
    for (const [path, page, title] of PAGES) {
      pages.get(path, async (_req, reply) => {
        reply.type('text/html; charset=utf-8').send(ctx.renderer.render(page, { title }));
      });
    }
  });
}
