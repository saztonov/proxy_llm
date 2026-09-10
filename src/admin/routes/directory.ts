import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminCtx } from '../ctx.js';
import { parseOr400, sendError, idParam, optionalLimit } from '../validation.js';
import { actorOf } from '../audit.js';
import { SLUG, EMPLOYEE_LOGIN } from '../../cli/admin.js';
import type { DepartmentListRow, EmployeeListRow, DepartmentPatch, EmployeePatch } from '../../storage/directory-repo.js';

const deptCreate = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG, 'slug: 1-32 chars of a-z 0-9 _ -'),
  name: z.string().trim().min(1).max(100),
  maxConcurrency: optionalLimit(200),
  maxPending: optionalLimit(1000),
}).strict();
const deptPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  maxConcurrency: optionalLimit(200),
  maxPending: optionalLimit(1000),
  enabled: z.boolean().optional(),
}).strict();
const empCreate = z.object({
  login: z.string().trim().toLowerCase().regex(EMPLOYEE_LOGIN, 'login: 1-64 chars of a-z 0-9 . _ -'),
  displayName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200).nullable().optional(),
  departmentId: z.number().int().positive(),
  maxConcurrency: optionalLimit(200),
  maxPending: optionalLimit(1000),
}).strict();
const empPatch = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  departmentId: z.number().int().positive().optional(),
  maxConcurrency: optionalLimit(200),
  maxPending: optionalLimit(1000),
  enabled: z.boolean().optional(),
}).strict();
const empQuery = z.object({ departmentId: z.coerce.number().int().positive().optional() });

function deptView(r: DepartmentListRow) {
  return {
    id: r.id, slug: r.slug, name: r.name, enabled: r.enabled === 1, maxConcurrency: r.max_concurrency,
    maxPending: r.max_pending, employeesCount: r.employees_count, activeTokens: r.active_tokens,
  };
}

function empView(r: EmployeeListRow) {
  return {
    id: r.id, login: r.login, displayName: r.display_name, email: r.email, departmentId: r.department_id,
    departmentName: r.department_name, enabled: r.enabled === 1, maxConcurrency: r.max_concurrency,
    maxPending: r.max_pending, activeTokens: r.active_tokens,
  };
}

/** Отключение отдела или сотрудника гасит его ключи сразу (снапшот реестра агентов). */
export async function registerDirectoryRoutes(app: FastifyInstance, ctx: AdminCtx): Promise<void> {
  const dir = ctx.repos.directory;
  const deptById = (id: number) => dir.listDepartments().find((d) => d.id === id);
  const empById = (id: number) => dir.listEmployees().find((e) => e.id === id);

  app.get('/departments', async (_req, reply) => {
    reply.send({ departments: dir.listDepartments().map(deptView) });
  });

  app.post('/departments', async (req, reply) => {
    const b = parseOr400(deptCreate, req.body, reply);
    if (!b) return;
    const id = ctx.change(() => {
      const newId = dir.createDepartment({ slug: b.slug, name: b.name, max_concurrency: b.maxConcurrency ?? null, max_pending: b.maxPending ?? null }, Date.now());
      ctx.audit.record(actorOf(req), 'department.create', 'department', newId, { slug: b.slug, name: b.name });
      return newId;
    });
    reply.code(201).send({ department: deptView(deptById(id)!) });
  });

  app.patch('/departments/:id', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const b = parseOr400(deptPatch, req.body, reply);
    if (!b) return;
    if (!dir.getDepartment(p.id)) return sendError(reply, 404, 'not_found', 'department not found');
    const patch: DepartmentPatch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.maxConcurrency !== undefined) patch.max_concurrency = b.maxConcurrency;
    if (b.maxPending !== undefined) patch.max_pending = b.maxPending;
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    ctx.change(() => {
      dir.updateDepartment(p.id, patch, Date.now());
      ctx.audit.record(actorOf(req), 'department.update', 'department', p.id, { fields: Object.keys(b), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}) });
    });
    reply.send({ department: deptView(deptById(p.id)!) });
  });

  app.get('/employees', async (req, reply) => {
    const q = parseOr400(empQuery, req.query, reply);
    if (!q) return;
    reply.send({ employees: dir.listEmployees(q.departmentId ? { departmentId: q.departmentId } : {}).map(empView) });
  });

  app.post('/employees', async (req, reply) => {
    const b = parseOr400(empCreate, req.body, reply);
    if (!b) return;
    if (!dir.getDepartment(b.departmentId)) {
      return sendError(reply, 400, 'invalid_request', 'department not found', { issues: [{ path: 'departmentId', message: 'department not found' }] });
    }
    const id = ctx.change(() => {
      const newId = dir.createEmployee({
        login: b.login, display_name: b.displayName, email: b.email ?? null, department_id: b.departmentId,
        max_concurrency: b.maxConcurrency ?? null, max_pending: b.maxPending ?? null,
      }, Date.now());
      ctx.audit.record(actorOf(req), 'employee.create', 'employee', newId, { login: b.login, departmentId: b.departmentId });
      return newId;
    });
    reply.code(201).send({ employee: empView(empById(id)!) });
  });

  app.patch('/employees/:id', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const b = parseOr400(empPatch, req.body, reply);
    if (!b) return;
    if (!dir.getEmployee(p.id)) return sendError(reply, 404, 'not_found', 'employee not found');
    if (b.departmentId !== undefined && !dir.getDepartment(b.departmentId)) {
      return sendError(reply, 400, 'invalid_request', 'department not found', { issues: [{ path: 'departmentId', message: 'department not found' }] });
    }
    const patch: EmployeePatch = {};
    if (b.displayName !== undefined) patch.display_name = b.displayName;
    if (b.email !== undefined) patch.email = b.email;
    if (b.departmentId !== undefined) patch.department_id = b.departmentId;
    if (b.maxConcurrency !== undefined) patch.max_concurrency = b.maxConcurrency;
    if (b.maxPending !== undefined) patch.max_pending = b.maxPending;
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    ctx.change(() => {
      dir.updateEmployee(p.id, patch, Date.now());
      ctx.audit.record(actorOf(req), 'employee.update', 'employee', p.id, { fields: Object.keys(b), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}) });
    });
    reply.send({ employee: empView(empById(p.id)!) });
  });
}
