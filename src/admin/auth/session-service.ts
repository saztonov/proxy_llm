import { randomBytes, randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { AdminUsersRepo, AdminUserRow } from '../../storage/admin-users-repo.js';
import type { AdminSessionsRepo } from '../../storage/admin-sessions-repo.js';
import { sha256Hex } from '../../clients/tokens.js';
import type { AdminKeys } from './keys.js';
import { signAccessToken, verifyAccessToken, type AccessClaims } from './jwt.js';
import { hashPassword, verifyPassword, needsRehash, validateNewPassword } from './password.js';
import { csrfTokenFor } from './csrf.js';
import { LoginThrottle } from './login-throttle.js';

export interface AdminPublic {
  id: number;
  login: string;
  displayName: string;
}

export interface IssuedSession {
  admin: AdminPublic;
  sid: string;
  access: string;
  accessTtlSec: number;
  refresh: string;
  refreshExpiresAt: number;
  csrf: string;
}

export interface ClientMeta {
  ip: string;
  userAgent: string | null;
}

export type LoginOutcome =
  | { kind: 'ok'; session: IssuedSession }
  | { kind: 'invalid'; failures: number }
  | { kind: 'locked'; retryAfterSec: number }
  | { kind: 'busy' };

export type RefreshOutcome =
  | { kind: 'ok'; session: IssuedSession }
  | { kind: 'conflict' }
  | { kind: 'reuse'; admin: AdminPublic | null }
  | { kind: 'invalid' };

export type ChangePasswordOutcome = { kind: 'ok' } | { kind: 'invalid' } | { kind: 'weak'; message: string } | { kind: 'busy' };

export interface SessionServiceDeps {
  config: Config;
  users: AdminUsersRepo;
  sessions: AdminSessionsRepo;
  keys: AdminKeys;
  logger: Logger;
  now?: () => number;
}

/** Больше двух scrypt (32 МиБ каждый) одновременно не считаем: бюджет памяти юнита мал. */
const MAX_PARALLEL_SCRYPT = 2;

export function toPublic(u: AdminUserRow): AdminPublic {
  return { id: u.id, login: u.login, displayName: u.display_name };
}

/**
 * Сессии администраторов: короткий access-JWT (15 мин) + opaque refresh с ротацией.
 *
 * Отзыв надёжен без списков в памяти: access-JWT несёт family_id сессии, и каждый запрос
 * сверяет его с admin_sessions (один PK-lookup). Поэтому logout, смена пароля, отключение
 * админа и CLI revoke-sessions действуют сразу и переживают рестарт.
 *
 * Повторное предъявление уже ротированного refresh вне короткого grace-окна (гонка двух
 * вкладок) считается кражей: отзывается вся цепочка, и в Telegram уходит алерт.
 */
export class SessionService {
  readonly throttle: LoginThrottle;
  private readonly dummyHash: Promise<string>;
  private readonly now: () => number;
  private inFlightScrypt = 0;

  constructor(private readonly deps: SessionServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.throttle = new LoginThrottle({
      maxAttempts: deps.config.ADMIN_LOGIN_MAX_ATTEMPTS,
      windowMs: deps.config.ADMIN_LOGIN_WINDOW_SEC * 1000,
      now: this.now,
    });
    // Для несуществующего логина считаем scrypt по фиктивному хэшу: время ответа не выдаёт,
    // есть ли такой администратор.
    this.dummyHash = hashPassword(randomBytes(24).toString('hex'));
  }

  private async scryptGuard<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
    if (this.inFlightScrypt >= MAX_PARALLEL_SCRYPT) return 'busy';
    this.inFlightScrypt += 1;
    try {
      return await fn();
    } finally {
      this.inFlightScrypt -= 1;
    }
  }

  async login(login: string, password: string, meta: ClientMeta): Promise<LoginOutcome> {
    const name = login.trim();
    const gate = this.throttle.check(name);
    if (!gate.allowed) return { kind: 'locked', retryAfterSec: gate.retryAfterSec };
    const user = this.deps.users.getByLogin(name);
    const hash = user?.password_hash ?? (await this.dummyHash);
    const ok = await this.scryptGuard(() => verifyPassword(password, hash));
    if (ok === 'busy') return { kind: 'busy' };
    if (!user || !ok || user.enabled !== 1) return { kind: 'invalid', failures: this.throttle.fail(name) };

    this.throttle.reset(name);
    const now = this.now();
    if (needsRehash(user.password_hash)) {
      this.deps.users.setPassword(user.id, await hashPassword(password), now);
    }
    this.deps.users.touchLogin(user.id, now);
    this.deps.sessions.purgeExpired(now);
    return { kind: 'ok', session: this.issue(user, meta, randomUUID(), null).session };
  }

  /** Новая строка сессии в цепочке familyId. absoluteExpiresAt=null — новая цепочка. */
  private issue(user: AdminUserRow, meta: ClientMeta, familyId: string, absoluteExpiresAt: number | null): { session: IssuedSession; rowId: number } {
    const cfg = this.deps.config;
    const now = this.now();
    const refresh = 'pl_rt_' + randomBytes(32).toString('base64url');
    const absolute = absoluteExpiresAt ?? now + cfg.ADMIN_SESSION_ABSOLUTE_TTL_SEC * 1000;
    const refreshExpiresAt = Math.min(now + cfg.ADMIN_REFRESH_TTL_SEC * 1000, absolute);
    const rowId = this.deps.sessions.insert({
      admin_id: user.id,
      token_sha256: sha256Hex(refresh),
      family_id: familyId,
      created_at: now,
      expires_at: refreshExpiresAt,
      absolute_expires_at: absolute,
      ip: meta.ip,
      user_agent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
    });
    const access = signAccessToken(this.deps.keys.jwt, { sub: user.id, sid: familyId }, cfg.ADMIN_ACCESS_TTL_SEC, now);
    return {
      rowId,
      session: {
        admin: toPublic(user),
        sid: familyId,
        access,
        accessTtlSec: cfg.ADMIN_ACCESS_TTL_SEC,
        refresh,
        refreshExpiresAt,
        csrf: this.csrfFor(familyId),
      },
    };
  }

  refresh(presented: string | undefined, meta: ClientMeta): RefreshOutcome {
    if (!presented) return { kind: 'invalid' };
    const now = this.now();
    const graceMs = this.deps.config.ADMIN_REFRESH_REUSE_GRACE_SEC * 1000;
    return this.deps.sessions.transaction((): RefreshOutcome => {
      const row = this.deps.sessions.getByHash(sha256Hex(presented));
      if (!row || row.revoked_at !== null) return { kind: 'invalid' };
      const user = this.deps.users.get(row.admin_id);
      if (row.replaced_by_id !== null) {
        if (now - (row.replaced_at ?? 0) <= graceMs) return { kind: 'conflict' };
        this.deps.sessions.revokeFamily(row.family_id, now, 'refresh_reuse');
        return { kind: 'reuse', admin: user ? toPublic(user) : null };
      }
      if (!user || user.enabled !== 1 || row.expires_at <= now || row.absolute_expires_at <= now) {
        this.deps.sessions.revokeFamily(row.family_id, now, 'expired');
        return { kind: 'invalid' };
      }
      const next = this.issue(user, meta, row.family_id, row.absolute_expires_at);
      this.deps.sessions.markReplaced(row.id, next.rowId, now);
      return { kind: 'ok', session: next.session };
    });
  }

  /** Подпись JWT доказывает, что токен выдан нами; жива ли сессия — знает только БД. */
  verifyAccess(token: string | undefined): AccessClaims | null {
    if (!token) return null;
    const now = this.now();
    const claims = verifyAccessToken(this.deps.keys.jwt, token, now);
    if (!claims) return null;
    return this.deps.sessions.isFamilyActive(claims.sid, claims.sub, now) ? claims : null;
  }

  csrfFor(sid: string): string {
    return csrfTokenFor(this.deps.keys.csrf, sid);
  }

  logout(opts: { sid?: string | undefined; refresh?: string | undefined }): void {
    const now = this.now();
    if (opts.sid) this.deps.sessions.revokeFamily(opts.sid, now, 'logout');
    if (opts.refresh) {
      const row = this.deps.sessions.getByHash(sha256Hex(opts.refresh));
      if (row) this.deps.sessions.revokeFamily(row.family_id, now, 'logout');
    }
  }

  async changePassword(adminId: number, current: string, next: string): Promise<ChangePasswordOutcome> {
    const user = this.deps.users.get(adminId);
    if (!user || user.enabled !== 1) return { kind: 'invalid' };
    const weak = validateNewPassword(next);
    if (weak) return { kind: 'weak', message: weak };
    const ok = await this.scryptGuard(() => verifyPassword(current, user.password_hash));
    if (ok === 'busy') return { kind: 'busy' };
    if (!ok) return { kind: 'invalid' };
    const now = this.now();
    this.deps.users.setPassword(user.id, await hashPassword(next), now);
    this.deps.sessions.revokeAllForAdmin(user.id, now, 'password_changed');
    return { kind: 'ok' };
  }

  admin(id: number): AdminPublic | null {
    const u = this.deps.users.get(id);
    return u && u.enabled === 1 ? toPublic(u) : null;
  }
}
