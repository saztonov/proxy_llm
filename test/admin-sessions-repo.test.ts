import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { ConflictError } from '../src/storage/errors.js';
import { AdminUsersRepo } from '../src/storage/admin-users-repo.js';
import { AdminSessionsRepo } from '../src/storage/admin-sessions-repo.js';
import { AdminAuditRepo } from '../src/storage/admin-audit-repo.js';

describe('admin users, sessions, audit', () => {
  let dir: string;
  let handle: DbHandle;
  let users: AdminUsersRepo;
  let sessions: AdminSessionsRepo;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-admin-'));
    handle = openDb(join(dir, 't.db'));
    users = new AdminUsersRepo(handle.db);
    sessions = new AdminSessionsRepo(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const session = (adminId: number, hash: string, family: string, now: number, absolute = now + 10_000) => ({
    admin_id: adminId, token_sha256: hash, family_id: family, created_at: now,
    expires_at: now + 5_000, absolute_expires_at: absolute, ip: '1.2.3.4', user_agent: 'ua',
  });
  const newAdmin = (login = 'a'): number => users.create({ login, password_hash: 'h', display_name: '' }, 1);

  it('admin logins are case-insensitive and unique', () => {
    const id = newAdmin('Root');
    expect(() => newAdmin('root')).toThrow(ConflictError);
    expect(users.getByLogin('ROOT')!.id).toBe(id);
    expect(users.count()).toBe(1);
    expect(users.list()[0]).not.toHaveProperty('password_hash');
  });

  it('family stays active across rotation and dies on revoke', () => {
    const admin = newAdmin();
    const s1 = sessions.insert(session(admin, 'h1', 'fam', 100));
    expect(sessions.isFamilyActive('fam', admin, 200)).toBe(true);
    sessions.transaction(() => {
      const s2 = sessions.insert(session(admin, 'h2', 'fam', 300));
      sessions.markReplaced(s1, s2, 300);
    });
    expect(sessions.getByHash('h1')!.replaced_by_id).not.toBeNull();
    expect(sessions.isFamilyActive('fam', admin, 400)).toBe(true);
    expect(sessions.isFamilyActive('fam', admin + 1, 400)).toBe(false);
    expect(sessions.revokeFamily('fam', 500, 'logout')).toBe(2);
    expect(sessions.isFamilyActive('fam', admin, 600)).toBe(false);
  });

  it('absolute expiry and a disabled admin end the session', () => {
    const admin = newAdmin();
    sessions.insert(session(admin, 'h1', 'f1', 100, 1_000));
    expect(sessions.isFamilyActive('f1', admin, 999)).toBe(true);
    expect(sessions.isFamilyActive('f1', admin, 1_000)).toBe(false);
    sessions.insert(session(admin, 'h2', 'f2', 100));
    users.setEnabled(admin, false, 200);
    expect(sessions.isFamilyActive('f2', admin, 300)).toBe(false);
  });

  it('revokeAllForAdmin returns families; purge drops dead rows', () => {
    const admin = newAdmin();
    sessions.insert(session(admin, 'h1', 'f1', 100));
    sessions.insert(session(admin, 'h2', 'f2', 100, 150));
    expect(sessions.revokeAllForAdmin(admin, 200, 'password_changed').sort()).toEqual(['f1', 'f2']);
    expect(sessions.isFamilyActive('f1', admin, 300)).toBe(false);
    expect(sessions.purgeExpired(160)).toBe(1);
    expect(sessions.getByHash('h2')).toBeNull();
    expect(sessions.getByHash('h1')).not.toBeNull();
  });

  it('audit log pages newest first', () => {
    const audit = new AdminAuditRepo(handle.db);
    for (let i = 1; i <= 5; i++) {
      audit.insert({ ts: i, admin_id: 1, admin_login: 'a', ip: null, action: `a${i}`, entity_type: 't', entity_id: String(i), details_json: null });
    }
    const first = audit.listRecent(2);
    expect(first.map((r) => r.action)).toEqual(['a5', 'a4']);
    expect(audit.listRecent(2, first[1]!.id).map((r) => r.action)).toEqual(['a3', 'a2']);
  });
});
