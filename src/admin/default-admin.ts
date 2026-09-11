import type { AdminUsersRepo, AdminUserRow } from '../storage/admin-users-repo.js';
import type { Logger } from '../utils/logger.js';

/**
 * Встроенный администратор для первого входа: admin@test.com / qwertyui12345.
 *
 * Создаётся только на пустой таблице админов, поэтому на базе, где админ уже есть (заведён
 * через CLI или встроенный давно сменил пароль), ничего не появляется и не сбрасывается.
 * Пара логин/пароль известна всем, кто видел репозиторий: пароль нужно сменить сразу после
 * входа («Настройки» → «Сменить пароль»). Пока он не сменён, интерфейс показывает баннер,
 * а сервис пишет предупреждение в лог на каждом старте.
 *
 * Хранится готовый scrypt-хэш, а не открытый пароль: считать scrypt на каждом старте (и в
 * каждом buildApp тестов) незачем. verifyPassword('qwertyui12345', хэш) === true проверяет тест.
 */
export const DEFAULT_ADMIN_LOGIN = 'admin@test.com';
export const DEFAULT_ADMIN_PASSWORD_HASH =
  'scrypt$32768$8$3$g6v5LFbwqbMild0pAQFIXw$j2CVZ4PicJ3RS-OmYT6RUkaKxt3Ms7dCmiWFguGqBbg';

/** Пароль этой учётки всё ещё тот, что по умолчанию (после смены хэш другой). */
export function usesDefaultPassword(row: Pick<AdminUserRow, 'password_hash'>): boolean {
  return row.password_hash === DEFAULT_ADMIN_PASSWORD_HASH;
}

/** Создаёт встроенного админа, если админов нет вовсе. Возвращает true, если создал. */
export function ensureDefaultAdmin(users: AdminUsersRepo, logger: Logger, now = Date.now()): boolean {
  if (users.count() > 0) {
    const stale = users.list().filter((u) => u.enabled === 1 && usesDefaultPassword(users.get(u.id)!));
    for (const u of stale) {
      logger.warn({ login: u.login }, 'admin still uses the default password: change it in /admin → Настройки');
    }
    return false;
  }
  users.create({ login: DEFAULT_ADMIN_LOGIN, password_hash: DEFAULT_ADMIN_PASSWORD_HASH, display_name: 'Администратор' }, now);
  logger.warn(
    { login: DEFAULT_ADMIN_LOGIN },
    'built-in admin created with the default password: log in to /admin and change it right away',
  );
  return true;
}
