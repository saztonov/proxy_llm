/*
 * proxy_llm — админ-панель. Classic script без сборки.
 * CSP: script-src 'self' — никакого inline-кода, eval и new Function.
 * Данные никогда не попадают в innerHTML/outerHTML/insertAdjacentHTML: только createElement + textContent.
 */
(function () {
  'use strict';

  const API = '/admin/api';
  const NO_RECOVERY_PATHS = new Set([API + '/auth/login', API + '/auth/refresh', API + '/auth/logout']);

  let csrf = null;
  let refreshPromise = null;

  // ================================================================
  // DOM-утилиты
  // ================================================================

  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;

  const PLAIN_ATTRS = new Set([
    'id', 'type', 'title', 'name', 'placeholder', 'role', 'colspan', 'rowspan', 'for',
    'min', 'max', 'step', 'autocomplete', 'scope', 'spellcheck',
  ]);

  function safeHref(v) {
    const s = String(v);
    // Только внутренние пути: никаких javascript:, data:, //host.
    return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '#';
  }

  /**
   * h('div', { class: 'x', text: 'y', 'data-id': 1, on: { click: fn } }, child, 'text', [more])
   * Строки превращаются в текстовые узлы, null/undefined/false пропускаются.
   */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const v = attrs[key];
        if (v === undefined || v === null || v === false) continue;
        if (key === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
        else if (key === 'text') el.textContent = String(v);
        else if (key === 'value') el.value = String(v);
        else if (key === 'checked') el.checked = true;
        else if (key === 'disabled') el.disabled = true;
        else if (key === 'selected') el.selected = true;
        else if (key === 'href') el.setAttribute('href', safeHref(v));
        else if (key === 'on') { for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]); }
        else if (PLAIN_ATTRS.has(key) || key.startsWith('data-') || key.startsWith('aria-')) el.setAttribute(key, String(v));
        else throw new Error('h(): неподдерживаемый атрибут ' + key);
      }
    }
    return append(el, children);
  }

  function append(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const td = (content, cls) => h('td', cls ? { class: cls } : null, content);
  const mono = (text, title) => h('span', { class: 'mono', title }, text == null || text === '' ? '—' : String(text));
  const muted = (text, title) => h('span', { class: 'muted', title }, text);
  const badge = (text, kind) => h('span', { class: 'badge badge-' + kind }, text);
  const link = (href, text) => h('a', { href }, text);

  function setRows(tbody, rows, colspan, emptyText) {
    if (rows.length) tbody.replaceChildren(...rows);
    else tbody.replaceChildren(h('tr', null, h('td', { colspan, class: 'muted' }, emptyText)));
  }

  /** Кнопка действия в таблице: на время запроса disabled, ошибка — в toast. */
  function actionBtn(text, handler, extraClass, disabled) {
    const b = h('button', { type: 'button', class: 'btn btn-small' + (extraClass ? ' ' + extraClass : ''), disabled }, text);
    b.addEventListener('click', () => { busy(b, () => handler(b)); });
    return b;
  }

  async function busy(btn, fn) {
    if (btn && btn.disabled) return undefined;
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } catch (err) {
      console.error(err);
      toast(friendlyError(err), true);
      return undefined;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function fillSelect(sel, items, opts) {
    const o = opts || {};
    const current = o.value !== undefined ? o.value : sel.value;
    const nodes = [];
    if (o.empty !== undefined) nodes.push(h('option', { value: '' }, o.empty));
    for (const it of items) nodes.push(h('option', { value: String(it.value), disabled: it.disabled }, it.label));
    sel.replaceChildren(...nodes);
    selectValue(sel, current);
  }

  function selectValue(sel, v) {
    sel.value = v == null ? '' : String(v);
    if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
  }

  function qs(params) {
    const u = new URLSearchParams();
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (v === undefined || v === null || v === '' || v === false) continue;
      u.set(k, String(v));
    }
    const s = u.toString();
    return s ? '?' + s : '';
  }

  // ================================================================
  // Форматирование
  // ================================================================

  const pad = (n) => String(n).padStart(2, '0');

  function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) {
      let n = Number(v);
      if (n < 1e11) n *= 1000; // секунды → мс
      const d = new Date(n);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const toMs = (v) => { const d = toDate(v); return d ? d.getTime() : 0; };
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function fmtDate(v) {
    const d = toDate(v);
    if (!d) return '—';
    return `${isoDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toLocalInput(v) {
    const d = toDate(v);
    return d ? `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  }

  function fmtMoney(v) {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    if (n > 0 && n < 0.0001) return '<$0.0001';
    return '$' + n.toFixed(4);
  }

  const intFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  function fmtInt(v) {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? intFmt.format(n) : '—';
  }
  const fmtMsDur = (v) => (v === null || v === undefined ? '—' : fmtInt(v) + ' мс');

  function errText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }

  const lines = (text) => Array.from(new Set(String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  const idVal = (v) => (/^\d+$/.test(String(v)) ? Number(v) : v);

  // ================================================================
  // Toast
  // ================================================================

  let toastTimer = null;
  const popoverSupported = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';

  function toastPopover(el, show) {
    // Popover попадает в top layer — тост виден поверх открытого модального диалога.
    if (!popoverSupported || !el.hasAttribute('popover')) return;
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      if (show) el.showPopover();
    } catch (_) { /* без popover тост просто останется под диалогом */ }
  }

  function toast(msg, isError) {
    const el = $('toast');
    if (!el) return;
    if (popoverSupported && !el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
    el.textContent = String(msg);
    el.classList.toggle('toast-error', !!isError);
    el.classList.remove('hidden');
    toastPopover(el, true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      toastPopover(el, false);
    }, isError ? 7000 : 3500);
  }

  // ================================================================
  // API
  // ================================================================

  function redirectToLogin() {
    location.assign('/admin/login?next=' + enc(location.pathname + location.search));
    return new Promise(() => {}); // страница уходит, дальше ничего не делаем
  }

  function networkError() {
    const err = new Error('Нет связи с сервером');
    err.status = 0;
    err.code = 'network';
    err.issues = [];
    err.retryAfterSec = null;
    return err;
  }

  async function rawFetch(method, url, body, withCsrf) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && withCsrf) headers['x-csrf-token'] = csrf || '';
    try {
      return await fetch(url, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (_) {
      throw networkError();
    }
  }

  async function readBody(res) {
    if (res.status === 204) return null;
    let text = '';
    try { text = await res.text(); } catch (_) { return null; }
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function makeApiError(res, data) {
    const e = data && typeof data === 'object' && data.error && typeof data.error === 'object' ? data.error : {};
    const hasMessage = typeof e.message === 'string' && e.message !== '';
    const err = new Error(hasMessage ? e.message : 'Ошибка сервера (HTTP ' + res.status + ')');
    err.status = res.status;
    err.code = typeof e.code === 'string' ? e.code : null;
    err.serverMessage = hasMessage;
    err.issues = Array.isArray(e.issues) ? e.issues : [];
    let ra = Number(e.retryAfterSec);
    if (!Number.isFinite(ra) || ra <= 0) {
      const hdr = Number(res.headers.get('retry-after'));
      ra = Number.isFinite(hdr) && hdr > 0 ? hdr : NaN;
    }
    err.retryAfterSec = Number.isFinite(ra) ? Math.ceil(ra) : null;
    return err;
  }

  async function syncCsrfQuiet() {
    try {
      const res = await rawFetch('GET', API + '/auth/me', undefined, false);
      if (res.status === 200) {
        const d = await readBody(res);
        if (d && typeof d.csrf === 'string') csrf = d.csrf;
      }
    } catch (_) { /* не критично: следующий запрос сам восстановит csrf */ }
  }

  /** Single-flight обновление сессии. 409 — другая вкладка уже обновила cookie. */
  function refreshSession() {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const res = await rawFetch('POST', API + '/auth/refresh', undefined, false);
        const data = await readBody(res);
        if (res.status === 200) {
          if (data && typeof data.csrf === 'string') csrf = data.csrf;
          return;
        }
        if (res.status === 409) {
          await syncCsrfQuiet(); // sid сменился в другой вкладке — нужен новый csrf
          return;
        }
        if (res.status === 401) {
          await redirectToLogin();
          return;
        }
        throw makeApiError(res, data);
      })().finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  /**
   * api('GET', '/sites') или api('POST', '/admin/api/sites', {...}).
   * 401 → refresh → повтор; 403 csrf_invalid → /auth/me → повтор. Каждое восстановление — не больше одного раза.
   */
  async function api(method, path, body) {
    const url = path.startsWith('/admin/') ? path : API + path;
    const urlPath = url.split('?')[0];
    const canRecover = !NO_RECOVERY_PATHS.has(urlPath);
    let refreshed = false;
    let csrfRetried = false;
    for (;;) {
      const res = await rawFetch(method, url, body, true);
      if (res.ok) return readBody(res);
      const data = await readBody(res);
      const err = makeApiError(res, data);
      if (res.status === 401 && canRecover && err.code !== 'invalid_credentials') {
        if (refreshed) return redirectToLogin();
        refreshed = true;
        await refreshSession();
        continue;
      }
      if (res.status === 403 && err.code === 'csrf_invalid' && !csrfRetried) {
        csrfRetried = true;
        await loadMe();
        continue;
      }
      throw err;
    }
  }

  async function loadMe() {
    const d = await api('GET', '/auth/me');
    if (d && typeof d.csrf === 'string') csrf = d.csrf;
    return d;
  }

  // ================================================================
  // Ошибки
  // ================================================================

  function friendlyError(err) {
    if (!err) return 'Неизвестная ошибка';
    if (err.display) return err.display;
    if (err.clientSide) return err.message;
    if (err.status === 0) return 'Нет связи с сервером. Проверьте соединение и повторите.';
    if (err.status === 409) return err.serverMessage ? err.message : 'Уже существует';
    if (err.status === 429) {
      return err.retryAfterSec ? `Слишком часто, повторите через ${err.retryAfterSec} с` : 'Слишком часто, повторите позже';
    }
    if (err.status === 503 && err.code === 'busy') return 'Сервер занят, повторите';
    if (err.status === 400 && err.issues && err.issues.length && !err.serverMessage) return 'Проверьте поля формы';
    return err.message || 'Ошибка';
  }

  function validationError(issues) {
    const err = new Error('Проверьте поля формы');
    err.status = 400;
    err.code = 'validation';
    err.issues = issues;
    err.clientSide = true;
    return err;
  }

  function throwIfIssues(issues) {
    if (issues.length) throw validationError(issues);
  }

  function showBanner(id, err) {
    const el = $(id);
    if (!el) { toast(friendlyError(err), true); return; }
    el.textContent = friendlyError(err);
    el.classList.remove('hidden');
  }

  function hideBanner(id) {
    const el = $(id);
    if (el) { el.textContent = ''; el.classList.add('hidden'); }
  }

  function showFatal(err) {
    console.error(err);
    const main = document.querySelector('main');
    const msg = 'Не удалось загрузить страницу: ' + friendlyError(err);
    if (main) main.prepend(h('div', { class: 'form-error', role: 'alert' }, msg));
    else toast(msg, true);
  }

  // ================================================================
  // Формы
  // ================================================================

  const fe = (form, name) => form.elements.namedItem(name);
  const fval = (form, name) => { const el = fe(form, name); return el ? String(el.value).trim() : ''; };
  const fchecked = (form, name) => { const el = fe(form, name); return !!(el && el.checked); };

  function fset(form, name, v) {
    const el = fe(form, name);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.tagName === 'SELECT') selectValue(el, v);
    else el.value = v === null || v === undefined ? '' : String(v);
  }

  /** Целое из поля: пусто → null; мусор → issue. */
  function readInt(form, name, min, issues) {
    const el = fe(form, name);
    if (el && el.validity && el.validity.badInput) {
      issues.push({ path: name, message: 'Введите целое число' });
      return null;
    }
    const s = fval(form, name);
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isInteger(n) || n < min) {
      issues.push({ path: name, message: min > 0 ? `Целое число не меньше ${min}` : 'Целое неотрицательное число' });
      return null;
    }
    return n;
  }

  /** Поля, значение которых отличается от исходного. */
  function diff(orig, next) {
    const out = {};
    for (const k of Object.keys(next)) {
      const a = orig[k] === undefined ? null : orig[k];
      const b = next[k] === undefined ? null : next[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = next[k];
    }
    return out;
  }

  /** Убирает null — для POST, где «нет поля» = значение по умолчанию. */
  function compact(obj) {
    const out = {};
    for (const k of Object.keys(obj)) if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
    return out;
  }

  function setFormMode(form, mode) {
    form.dataset.mode = mode;
    form.querySelectorAll('.edit-only').forEach((el) => el.classList.toggle('hidden', mode !== 'edit'));
    form.querySelectorAll('.create-only').forEach((el) => el.classList.toggle('hidden', mode !== 'create'));
    form.querySelectorAll('[data-immutable]').forEach((el) => { el.readOnly = mode === 'edit'; });
  }

  function formErrorBox(form) {
    let box = form.querySelector(':scope > .form-error');
    if (!box) {
      box = h('div', { class: 'form-error hidden', role: 'alert' });
      form.prepend(box);
    }
    return box;
  }

  function clearFormErrors(form) {
    form.querySelectorAll('.error-text').forEach((el) => el.remove());
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const box = form.querySelector(':scope > .form-error');
    if (box) { box.replaceChildren(); box.classList.add('hidden'); }
  }

  function issuePath(path) {
    if (Array.isArray(path)) return path.map(String);
    if (path === null || path === undefined) return [];
    return String(path).split('.').filter(Boolean);
  }

  function fieldFor(form, parts) {
    const candidates = [parts.join('.'), parts[0]];
    for (const name of candidates) {
      if (!name) continue;
      let el = fe(form, name);
      if (el && typeof el.length === 'number' && !el.tagName) el = el[0]; // RadioNodeList
      if (el && el.tagName) return el;
    }
    return null;
  }

  function showFormErrors(form, err) {
    if (!err || !err.clientSide) console.error(err);
    const box = formErrorBox(form);
    const unplaced = [];
    let firstField = null;
    for (const issue of (err && err.issues) || []) {
      if (!issue) continue;
      const parts = issuePath(issue.path);
      const msg = issue.message ? String(issue.message) : 'Некорректное значение';
      const field = parts.length ? fieldFor(form, parts) : null;
      const row = field && field.closest('.form-row');
      if (row && !field.closest('.hidden')) {
        field.setAttribute('aria-invalid', 'true');
        row.appendChild(h('div', { class: 'error-text' }, msg));
        if (!firstField) firstField = field;
      } else {
        unplaced.push((parts.length ? parts.join('.') + ': ' : '') + msg);
      }
    }
    box.replaceChildren(h('div', null, friendlyError(err)));
    if (unplaced.length) box.appendChild(h('ul', null, unplaced.map((m) => h('li', null, m))));
    box.classList.remove('hidden');
    if (firstField && typeof firstField.focus === 'function') firstField.focus();
  }

  /** submit → preventDefault, кнопки disabled на время запроса, ошибки — в форме. */
  function onSubmit(form, handler) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (form.dataset.busy) return;
      clearFormErrors(form);
      const buttons = Array.from(form.querySelectorAll('button'));
      const prev = buttons.map((b) => b.disabled);
      form.dataset.busy = '1';
      buttons.forEach((b) => { b.disabled = true; });
      try {
        await handler();
      } catch (err) {
        showFormErrors(form, err);
      } finally {
        delete form.dataset.busy;
        buttons.forEach((b, i) => { b.disabled = prev[i]; });
      }
    });
  }

  function submitNow(form) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  function openDialog(dlg) {
    if (!dlg.open) dlg.showModal();
  }

  // ================================================================
  // Диалог с секретом
  // ================================================================

  let secretAck = false;

  function initDialogs() {
    document.addEventListener('click', (ev) => {
      const t = ev.target;
      const btn = t && t.closest ? t.closest('[data-close]') : null;
      if (!btn) return;
      const dlg = btn.closest('dialog');
      if (dlg && dlg.id !== 'dlg-secret') dlg.close();
    });

    const dlg = $('dlg-secret');
    if (!dlg) return;
    const input = $('dlg-secret-value');
    dlg.addEventListener('cancel', (ev) => ev.preventDefault());
    dlg.addEventListener('close', () => {
      if (!secretAck && input.value) {
        // Закрыто не кнопкой (close request в обход cancel) — не теряем секрет.
        dlg.showModal();
        return;
      }
      input.value = '';
      $('dlg-secret-hint').replaceChildren();
      secretAck = false;
    });
    $('dlg-secret-close').addEventListener('click', () => {
      secretAck = true;
      dlg.close();
    });
    $('dlg-secret-copy').addEventListener('click', copySecret);
    input.addEventListener('focus', () => input.select());
  }

  function showSecret(title, secret, hintNodes) {
    const dlg = $('dlg-secret');
    const input = $('dlg-secret-value');
    $('dlg-secret-title').textContent = title;
    input.value = secret == null ? '' : String(secret);
    $('dlg-secret-hint').replaceChildren(...(hintNodes || []));
    $('dlg-secret-copy').textContent = 'Скопировать';
    secretAck = false;
    openDialog(dlg);
    input.focus();
    input.select();
  }

  async function copySecret() {
    const input = $('dlg-secret-value');
    const btn = $('dlg-secret-copy');
    const value = input.value;
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(value); ok = true; } catch (_) { ok = false; }
    }
    if (!ok) {
      input.focus();
      input.select();
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    }
    btn.textContent = ok ? 'Скопировано' : 'Выделите и скопируйте вручную';
    setTimeout(() => { btn.textContent = 'Скопировать'; }, 2500);
    if (!ok) { input.focus(); input.select(); }
  }

  function cursorHint(baseUrl) {
    return [
      h('p', { class: 'strong' }, 'Подключение в Cursor'),
      h('ol', null,
        h('li', null, 'Cursor → Settings → Models → OpenAI API Key: вставьте ключ из поля выше.'),
        h('li', null, 'Override OpenAI Base URL: ', h('code', null, baseUrl || '—')),
        h('li', null, 'Добавьте модель с именем ', h('code', null, 'default'), ' (или любым — прокси подставит назначенную).')),
    ];
  }

  // ================================================================
  // Общие куски страниц
  // ================================================================

  function statusOnOff(enabled, on, off) {
    return enabled ? badge(on || 'включён', 'ok') : badge(off || 'выключен', 'off');
  }

  function describeAllowed(list) {
    if (list === null || list === undefined) return 'наследуется';
    if (!Array.isArray(list)) return String(list);
    if (list.length === 0) return 'только модель по умолчанию';
    if (list.includes('*')) return 'любая модель';
    return 'список: ' + list.join(', ');
  }

  function allowedCell(list) {
    if (Array.isArray(list) && list.length && !list.includes('*')) {
      return h('span', { title: list.join('\n') }, `список (${list.length})`);
    }
    return describeAllowed(list);
  }

  function listCell(list) {
    if (!Array.isArray(list) || !list.length) return muted('нет');
    return h('span', { class: 'mono' }, list.join(', '));
  }

  function limitCell(v, def) {
    if (v !== null && v !== undefined) return fmtInt(v);
    return muted(def !== null && def !== undefined ? `по умолч. (${fmtInt(def)})` : 'по умолч.', 'Значение по умолчанию из настроек');
  }

  function empLabel(e) {
    return `${e.displayName || e.login} (${e.login})` + (e.enabled ? '' : ' — выключен');
  }

  function card(label, value, subLines, extraClass) {
    return h('div', { class: 'card' + (extraClass ? ' ' + extraClass : '') },
      h('div', { class: 'card-label' }, label),
      h('div', { class: 'card-value' }, value),
      (subLines || []).filter(Boolean).map((l) => h('div', { class: 'card-sub muted' }, l)));
  }

  // ================================================================
  // Страница: вход
  // ================================================================

  function safeNext(n) {
    if (typeof n !== 'string' || !n.startsWith('/admin') || n.startsWith('//')) return '/admin';
    if (n.startsWith('/admin/login')) return '/admin';
    return n;
  }

  async function pageLogin() {
    const next = safeNext(document.body.dataset.next);
    const form = $('form-login');
    try {
      const res = await rawFetch('POST', API + '/auth/refresh', undefined, false);
      if (res.status === 200) { location.replace(next); return; }
      if (res.status === 409) {
        // Другая вкладка только что обновила сессию — проверим, что cookie уже рабочие.
        const me = await rawFetch('GET', API + '/auth/me', undefined, false);
        if (me.status === 200) { location.replace(next); return; }
      }
    } catch (_) { /* показываем форму */ }

    $('login-checking').classList.add('hidden');
    form.classList.remove('hidden');
    fe(form, 'login').focus();

    onSubmit(form, async () => {
      const login = fval(form, 'login');
      const password = fe(form, 'password').value;
      const issues = [];
      if (!login) issues.push({ path: 'login', message: 'Введите логин' });
      if (!password) issues.push({ path: 'password', message: 'Введите пароль' });
      throwIfIssues(issues);
      try {
        await api('POST', '/auth/login', { login, password });
      } catch (err) {
        if (err.status === 401) {
          err.display = 'Неверный логин или пароль';
          fe(form, 'password').value = '';
        } else if (err.status === 429) {
          err.display = err.retryAfterSec
            ? `Слишком много попыток. Повторите через ${err.retryAfterSec} с`
            : 'Слишком много попыток. Повторите позже';
        } else if (err.status === 503) {
          err.display = 'Сервер занят, повторите через несколько секунд';
        }
        throw err;
      }
      location.replace(next);
    });
  }

  // ================================================================
  // Страница: сводка
  // ================================================================

  async function pageHome() {
    const reloadBtn = $('btn-summary-reload');

    async function load() {
      hideBanner('summary-error');
      let s;
      try {
        s = await api('GET', '/stats/summary');
      } catch (err) {
        showBanner('summary-error', err);
        return;
      }
      renderSummary(s || {});
    }

    reloadBtn.addEventListener('click', () => busy(reloadBtn, load));
    await busy(reloadBtn, load);
    setInterval(() => {
      if (document.visibilityState === 'visible' && !reloadBtn.disabled) busy(reloadBtn, load);
    }, 30000);
  }

  function renderSummary(s) {
    $('summary-generated').textContent = s.generatedAt ? 'Данные на ' + fmtDate(s.generatedAt) : '';

    const contours = [['sites', 'Сайты'], ['agents', 'Агенты']];
    const traffic = [];
    for (const [key, name] of contours) {
      const c = s[key] || {};
      for (const [per, perName] of [['hour', 'за час'], ['day', 'за 24 часа']]) {
        const a = c[per] || {};
        const p95 = per === 'day' ? ' · p95 ' + fmtMsDur(c.p95DayMs) : '';
        traffic.push(card(`${name} · ${perName}`, fmtInt(a.total || 0), [
          `успешно ${fmtInt(a.success || 0)} · ошибок ${fmtInt(a.errors || 0)}`,
          `ср. латентность ${fmtMsDur(a.avg_latency_ms === null || a.avg_latency_ms === undefined ? null : Math.round(a.avg_latency_ms))}${p95}`,
          `токенов ${fmtInt(a.total_tokens || 0)}`,
        ], a.errors > 0 ? 'card-warn' : null));
      }
    }
    $('summary-traffic').replaceChildren(...traffic);

    const fair = s.fairness || {};
    const act = s.active || {};
    $('summary-fairness').replaceChildren(
      ...contours.map(([key, name]) => {
        const f = fair[key] || {};
        return card(`${name} · слоты`, `${fmtInt(f.globalActive)} / ${fmtInt(f.globalConcurrency)}`,
          [`в работе сейчас: ${fmtInt(act[key])}`]);
      }));

    const perClient = [];
    for (const [key, name] of contours) {
      const list = ((fair[key] || {}).perClient || []).slice().sort((a, b) => (b.active || 0) - (a.active || 0));
      for (const p of list) {
        perClient.push(h('tr', null,
          td(name), td(mono(p.clientId)), td(fmtInt(p.active), 'num'),
          td(fmtInt(p.maxConcurrency), 'num'), td(fmtInt(p.maxPending), 'num')));
      }
    }
    setRows($('summary-perclient'), perClient, 5, 'Нет данных о клиентах');

    const spend = s.spend || {};
    const spendRows = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['last30d', '30 дней']].map(([key, name]) => {
      const sp = spend[key] || {};
      const site = sp.site || {};
      const agent = sp.agent || {};
      const total = sp.total || {};
      return h('tr', null,
        td(name),
        td(fmtMoney(site.cost_actual_usd), 'num'), td(fmtMoney(site.cost_approx_usd), 'num'),
        td(fmtMoney(agent.cost_actual_usd), 'num'), td(fmtMoney(agent.cost_approx_usd), 'num'),
        td(fmtMoney(total.cost_actual_usd), 'num strong'), td(fmtMoney(total.cost_approx_usd), 'num'),
        td(fmtInt(total.executions), 'num'),
        td(fmtInt(total.missing_rows), total.missing_rows > 0 ? 'num warn-text' : 'num'));
    });
    $('summary-spend').replaceChildren(...spendRows);

    const meta = [];
    if (s.priceSync) meta.push(`Цены синхронизированы за ${s.priceSync.lastOkDay || '—'} (${fmtDate(s.priceSync.at)}).`);
    else meta.push('Синхронизация цен ещё не выполнялась.');
    if (s.accountingStartedAt) meta.push(`Учёт расходов ведётся с ${s.accountingStartedAt}.`);
    $('summary-meta').textContent = meta.join(' ');
  }

  // ================================================================
  // Страница: сайты
  // ================================================================

  async function pageSites() {
    const tbody = $('sites-tbody');
    const form = $('form-site');
    const dlg = $('dlg-site');
    const tokForm = $('form-site-token');
    const tokDlg = $('dlg-site-tokens');
    const showRevoked = $('site-tokens-show-revoked');
    let data = { defaults: null, sites: [] };
    let editing = null;
    let tokensClientId = null;

    async function load() {
      hideBanner('sites-error');
      try {
        data = (await api('GET', '/sites')) || { defaults: null, sites: [] };
      } catch (err) {
        showBanner('sites-error', err);
        return;
      }
      renderDefaults();
      renderTable();
      if (tokDlg.open) renderTokens();
    }

    function kv(k, v) {
      return h('span', { class: 'kv' }, muted(k + ': '), v);
    }

    function renderDefaults() {
      const d = data.defaults;
      const box = $('sites-defaults');
      if (!d) { box.replaceChildren(); return; }
      box.replaceChildren(
        h('span', { class: 'strong' }, 'По умолчанию (env):'),
        kv('модель', mono(d.defaultModel)),
        kv('выбор модели', describeAllowed(d.allowedModels)),
        kv('fallback', listCell(d.fallbackModels)),
        kv('одновременных', fmtInt(d.maxConcurrency)),
        kv('очередь', fmtInt(d.maxPending)));
    }

    const inherited = (v) => (v === null || v === undefined ? h('div', { class: 'muted small' }, 'наследуется') : null);

    function loadCell(s) {
      const eff = s.effective || {};
      const live = s.live;
      return [
        h('div', { title: 'активно / одновременных' },
          `${live ? fmtInt(live.active) : '—'} / ${fmtInt(live ? live.maxConcurrency : eff.maxConcurrency)}`),
        h('div', { class: 'muted small' }, 'очередь ≤ ' + fmtInt(live ? live.maxPending : eff.maxPending)),
        s.maxConcurrency === null && s.maxPending === null ? h('div', { class: 'muted small' }, 'лимиты наследуются') : null,
      ];
    }

    function renderTable() {
      const rows = (data.sites || []).map((s) => {
        const eff = s.effective || {};
        const activeTokens = (s.tokens || []).filter((t) => !t.revokedAt).length;
        return h('tr', { class: s.enabled ? null : 'row-off' },
          td([
            h('div', { class: 'mono strong' }, s.clientId),
            s.source ? h('div', { class: 'muted small' }, s.source) : null,
            s.importedFrom ? h('div', { class: 'muted small' }, 'импорт: ' + s.importedFrom) : null,
          ]),
          td(statusOnOff(s.enabled)),
          td([mono(eff.defaultModel), inherited(s.defaultModel)]),
          td([allowedCell(eff.allowedModels), inherited(s.allowedModels)]),
          td([listCell(eff.fallbackModels), inherited(s.fallbackModels)]),
          td(loadCell(s), 'nowrap'),
          td(s.hasOpenrouterApiKey ? mono(s.openrouterApiKeyFp || 'задан', 'Отпечаток собственного ключа') : muted('общий')),
          td(activeTokens ? `${activeTokens} акт.` : muted('нет'), 'nowrap'),
          td(fmtDate(s.updatedAt), 'nowrap'),
          td(h('div', { class: 'actions' },
            actionBtn('Изменить', () => openForm(s)),
            actionBtn('Токены', () => openTokens(s.clientId)),
            actionBtn(s.enabled ? 'Выключить' : 'Включить', () => toggle(s), s.enabled ? 'btn-danger' : null))));
      });
      setRows(tbody, rows, 10, 'Сайтов пока нет');
    }

    async function toggle(s) {
      if (s.enabled && !window.confirm(`Выключить сайт «${s.clientId}»? Запросы с его токенами будут отклоняться.`)) return;
      await api('PATCH', '/sites/' + enc(s.clientId), { enabled: !s.enabled });
      toast(s.enabled ? 'Сайт выключен' : 'Сайт включён');
      await load();
    }

    // ---- форма сайта

    function allowedModeOf(list) {
      if (list === null || list === undefined) return 'inherit';
      if (list.length === 0) return 'default';
      if (list.includes('*')) return 'any';
      return 'list';
    }

    function fallbackModeOf(list) {
      if (list === null || list === undefined) return 'inherit';
      return list.length === 0 ? 'none' : 'list';
    }

    function syncModeRows() {
      $('site-allowedModels-row').classList.toggle('hidden', fval(form, 'allowedMode') !== 'list');
      $('site-fallbackModels-row').classList.toggle('hidden', fval(form, 'fallbackMode') !== 'list');
    }

    fe(form, 'allowedMode').addEventListener('change', syncModeRows);
    fe(form, 'fallbackMode').addEventListener('change', syncModeRows);
    fe(form, 'removeOpenrouterApiKey').addEventListener('change', (ev) => {
      const key = fe(form, 'openrouterApiKey');
      key.disabled = ev.target.checked;
      if (ev.target.checked) key.value = '';
    });

    function openForm(site) {
      editing = site || null;
      form.reset();
      clearFormErrors(form);
      setFormMode(form, site ? 'edit' : 'create');
      $('dlg-site-title').textContent = site ? 'Сайт ' + site.clientId : 'Новый сайт';
      const d = data.defaults || {};
      $('site-defaultModel-hint').textContent = 'Пусто — наследовать: ' + (d.defaultModel || '—');
      $('site-allowedMode-hint').textContent = 'По умолчанию: ' + describeAllowed(d.allowedModels);
      $('site-fallbackMode-hint').textContent = 'По умолчанию: ' +
        (Array.isArray(d.fallbackModels) && d.fallbackModels.length ? d.fallbackModels.join(', ') : 'нет');
      fe(form, 'maxConcurrency').placeholder = 'наследовать: ' + fmtInt(d.maxConcurrency);
      fe(form, 'maxPending').placeholder = 'наследовать: ' + fmtInt(d.maxPending);

      const key = fe(form, 'openrouterApiKey');
      key.disabled = false;
      key.placeholder = site && site.hasOpenrouterApiKey ? 'оставьте пустым, чтобы не менять' : '';
      $('site-openrouterApiKey-hint').textContent = site && site.hasOpenrouterApiKey
        ? `Задан свой ключ (${site.openrouterApiKeyFp || 'отпечаток неизвестен'}). Оставьте пустым, чтобы не менять.`
        : 'Пусто — общий ключ прокси.';
      $('site-removeKey-row').classList.toggle('hidden', !(site && site.hasOpenrouterApiKey));

      if (site) {
        fset(form, 'clientId', site.clientId);
        fset(form, 'source', site.source);
        fset(form, 'enabled', site.enabled);
        fset(form, 'defaultModel', site.defaultModel);
        fset(form, 'allowedMode', allowedModeOf(site.allowedModels));
        fset(form, 'allowedModels', allowedModeOf(site.allowedModels) === 'list' ? site.allowedModels.join('\n') : '');
        fset(form, 'fallbackMode', fallbackModeOf(site.fallbackModels));
        fset(form, 'fallbackModels', Array.isArray(site.fallbackModels) ? site.fallbackModels.join('\n') : '');
        fset(form, 'maxConcurrency', site.maxConcurrency);
        fset(form, 'maxPending', site.maxPending);
      }
      syncModeRows();
      openDialog(dlg);
      (site ? fe(form, 'defaultModel') : fe(form, 'clientId')).focus();
    }

    function modelsFromMode(mode, text, path, issues) {
      if (mode === 'inherit') return null;
      if (mode === 'default' || mode === 'none') return [];
      if (mode === 'any') return ['*'];
      const list = lines(text);
      if (!list.length) issues.push({ path, message: 'Добавьте хотя бы одну модель или выберите другой режим' });
      return list;
    }

    onSubmit(form, async () => {
      const issues = [];
      const next = {
        defaultModel: fval(form, 'defaultModel') || null,
        allowedModels: modelsFromMode(fval(form, 'allowedMode'), fe(form, 'allowedModels').value, 'allowedModels', issues),
        fallbackModels: modelsFromMode(fval(form, 'fallbackMode'), fe(form, 'fallbackModels').value, 'fallbackModels', issues),
        maxConcurrency: readInt(form, 'maxConcurrency', 1, issues),
        maxPending: readInt(form, 'maxPending', 0, issues),
        source: fval(form, 'source') || null,
      };
      const key = fe(form, 'openrouterApiKey').value.trim();

      if (editing) {
        next.enabled = fchecked(form, 'enabled');
        throwIfIssues(issues);
        const body = diff(editing, next);
        if (fchecked(form, 'removeOpenrouterApiKey')) body.openrouterApiKey = null;
        else if (key) body.openrouterApiKey = key;
        if (!Object.keys(body).length) { dlg.close(); toast('Изменений нет'); return; }
        await api('PATCH', '/sites/' + enc(editing.clientId), body);
        dlg.close();
        toast('Сайт сохранён');
      } else {
        const clientId = fval(form, 'clientId');
        if (!clientId) issues.push({ path: 'clientId', message: 'Укажите идентификатор клиента' });
        throwIfIssues(issues);
        const body = Object.assign({ clientId }, compact(next));
        if (key) body.openrouterApiKey = key;
        await api('POST', '/sites', body);
        dlg.close();
        toast('Сайт создан');
      }
      await load();
    });

    // ---- токены сайта

    const siteTokenName = (t) => (t.prefix ? t.prefix + '…' : '#' + t.hashPrefix);

    function openTokens(clientId) {
      tokensClientId = clientId;
      tokForm.reset();
      clearFormErrors(tokForm);
      renderTokens();
      openDialog(tokDlg);
    }

    function renderTokens() {
      const site = (data.sites || []).find((s) => s.clientId === tokensClientId);
      $('dlg-site-tokens-title').textContent = 'Токены сайта ' + tokensClientId;
      const tb = $('site-tokens-tbody');
      if (!site) { setRows(tb, [], 6, 'Сайт не найден'); return; }
      const list = (site.tokens || [])
        .filter((t) => showRevoked.checked || !t.revokedAt)
        .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
      setRows(tb, list.map((t) => h('tr', { class: t.revokedAt ? 'row-off' : null },
        td(mono(siteTokenName(t), 'hash: ' + t.hashPrefix)),
        td(t.label || '—'),
        td(fmtDate(t.createdAt), 'nowrap'),
        td(fmtDate(t.lastUsedAt), 'nowrap'),
        td(t.revokedAt ? badge('отозван ' + fmtDate(t.revokedAt), 'off') : badge('активен', 'ok')),
        td(t.revokedAt ? null : actionBtn('Отозвать', () => revokeToken(site, t), 'btn-danger')))),
      6, showRevoked.checked ? 'Токенов нет' : 'Активных токенов нет');
    }

    showRevoked.addEventListener('change', renderTokens);

    async function revokeToken(site, t) {
      const name = siteTokenName(t) + (t.label ? ` («${t.label}»)` : '');
      if (!window.confirm(`Отозвать токен ${name} сайта «${site.clientId}»? Портал с этим токеном перестанет получать ответы.`)) return;
      await api('POST', `/sites/${enc(site.clientId)}/tokens/${enc(t.id)}/revoke`);
      toast('Токен отозван');
      await load();
    }

    onSubmit(tokForm, async () => {
      const label = fval(tokForm, 'label');
      const clientId = tokensClientId;
      const res = await api('POST', `/sites/${enc(clientId)}/tokens`, label ? { label } : {});
      tokForm.reset();
      showSecret('Токен сайта ' + clientId, res && res.plaintext, [
        h('p', null, `Передайте токен владельцу портала «${clientId}» по защищённому каналу.`),
        h('p', null, 'Портал передаёт его в каждом запросе к прокси:'),
        h('pre', null, 'Authorization: Bearer <токен>'),
      ]);
      await load();
    });

    $('btn-site-add').addEventListener('click', () => openForm(null));
    const reloadBtn = $('btn-sites-reload');
    reloadBtn.addEventListener('click', () => busy(reloadBtn, load));
    await load();
  }

  // ================================================================
  // Страница: справочник
  // ================================================================

  async function pageDirectory() {
    const filter = $('emp-filter-dept');
    const deptForm = $('form-dept');
    const deptDlg = $('dlg-dept');
    const empForm = $('form-emp');
    const empDlg = $('dlg-emp');
    let depts = [];
    let emps = [];
    let defaults = null;
    let editingDept = null;
    let editingEmp = null;

    async function loadDefaults() {
      try {
        const s = await api('GET', '/settings');
        const ad = (s && s.agentDefaults) || {};
        const env = (s && s.env) || {};
        defaults = {
          maxConcurrency: ad.maxConcurrency != null ? ad.maxConcurrency : env.agentPrincipalMaxConcurrency,
          maxPending: ad.maxPending != null ? ad.maxPending : env.agentPrincipalMaxPending,
        };
      } catch (_) {
        defaults = null; // только для подсказок
      }
    }

    async function loadDepts() {
      hideBanner('depts-error');
      try {
        depts = ((await api('GET', '/departments')) || {}).departments || [];
      } catch (err) {
        showBanner('depts-error', err);
        return;
      }
      fillDeptSelects();
      renderDepts();
    }

    async function loadEmps() {
      hideBanner('emps-error');
      try {
        emps = ((await api('GET', '/employees' + qs({ departmentId: filter.value }))) || {}).employees || [];
      } catch (err) {
        showBanner('emps-error', err);
        return;
      }
      renderEmps();
    }

    async function loadAll() {
      await Promise.all([loadDefaults(), loadDepts(), loadEmps()]);
      renderDepts();
      renderEmps();
    }

    function deptItems(onlyEnabled) {
      return depts
        .filter((d) => !onlyEnabled || d.enabled)
        .map((d) => ({ value: d.id, label: d.name + (d.enabled ? '' : ' (выключен)') }));
    }

    function fillDeptSelects() {
      fillSelect(filter, deptItems(false), { empty: 'Все отделы' });
    }

    function renderDepts() {
      const def = defaults || {};
      setRows($('depts-tbody'), depts.map((d) => h('tr', { class: d.enabled ? null : 'row-off' },
        td(mono(d.slug)),
        td(d.name),
        td(statusOnOff(d.enabled)),
        td(limitCell(d.maxConcurrency, def.maxConcurrency), 'num'),
        td(limitCell(d.maxPending, def.maxPending), 'num'),
        td(fmtInt(d.employeesCount), 'num'),
        td(link('/admin/agent-tokens' + qs({ departmentId: d.id }), fmtInt(d.activeTokens)), 'num'),
        td(h('div', { class: 'actions' },
          actionBtn('Изменить', () => openDept(d)),
          actionBtn('Сотрудники', () => { selectValue(filter, d.id); return loadEmps(); }),
          actionBtn(d.enabled ? 'Выключить' : 'Включить', () => toggleDept(d), d.enabled ? 'btn-danger' : null))))),
      8, 'Отделов пока нет');
    }

    function renderEmps() {
      const def = defaults || {};
      setRows($('emps-tbody'), emps.map((e) => h('tr', { class: e.enabled ? null : 'row-off' },
        td(mono(e.login)),
        td(e.displayName),
        td(e.email || '—'),
        td(e.departmentName || '—'),
        td(statusOnOff(e.enabled, 'активен', 'выключен')),
        td(limitCell(e.maxConcurrency, def.maxConcurrency), 'num'),
        td(limitCell(e.maxPending, def.maxPending), 'num'),
        td(link('/admin/agent-tokens' + qs({ departmentId: e.departmentId, employeeId: e.id }), fmtInt(e.activeTokens)), 'num'),
        td(h('div', { class: 'actions' },
          actionBtn('Изменить', () => openEmp(e)),
          actionBtn(e.enabled ? 'Выключить' : 'Включить', () => toggleEmp(e), e.enabled ? 'btn-danger' : null))))),
      9, filter.value ? 'В отделе нет сотрудников' : 'Сотрудников пока нет');
    }

    function limitPlaceholders(form) {
      const def = defaults || {};
      fe(form, 'maxConcurrency').placeholder = def.maxConcurrency != null ? 'по умолчанию: ' + def.maxConcurrency : 'по умолчанию';
      fe(form, 'maxPending').placeholder = def.maxPending != null ? 'по умолчанию: ' + def.maxPending : 'по умолчанию';
    }

    // ---- отделы

    function openDept(d) {
      editingDept = d || null;
      deptForm.reset();
      clearFormErrors(deptForm);
      setFormMode(deptForm, d ? 'edit' : 'create');
      $('dlg-dept-title').textContent = d ? 'Отдел ' + d.name : 'Новый отдел';
      limitPlaceholders(deptForm);
      if (d) {
        fset(deptForm, 'slug', d.slug);
        fset(deptForm, 'name', d.name);
        fset(deptForm, 'maxConcurrency', d.maxConcurrency);
        fset(deptForm, 'maxPending', d.maxPending);
        fset(deptForm, 'enabled', d.enabled);
      }
      openDialog(deptDlg);
      fe(deptForm, d ? 'name' : 'slug').focus();
    }

    async function toggleDept(d) {
      if (d.enabled && !window.confirm(`Выключить отдел «${d.name}»?`)) return;
      await api('PATCH', '/departments/' + enc(d.id), { enabled: !d.enabled });
      toast(d.enabled ? 'Отдел выключен' : 'Отдел включён');
      await Promise.all([loadDepts(), loadEmps()]);
    }

    onSubmit(deptForm, async () => {
      const issues = [];
      const next = {
        name: fval(deptForm, 'name'),
        maxConcurrency: readInt(deptForm, 'maxConcurrency', 1, issues),
        maxPending: readInt(deptForm, 'maxPending', 0, issues),
      };
      if (!next.name) issues.push({ path: 'name', message: 'Укажите название' });
      if (editingDept) {
        next.enabled = fchecked(deptForm, 'enabled');
        throwIfIssues(issues);
        const body = diff(editingDept, next);
        if (!Object.keys(body).length) { deptDlg.close(); toast('Изменений нет'); return; }
        await api('PATCH', '/departments/' + enc(editingDept.id), body);
        toast('Отдел сохранён');
      } else {
        const slug = fval(deptForm, 'slug');
        if (!slug) issues.push({ path: 'slug', message: 'Укажите slug' });
        throwIfIssues(issues);
        await api('POST', '/departments', Object.assign({ slug }, compact(next)));
        toast('Отдел создан');
      }
      deptDlg.close();
      await Promise.all([loadDepts(), loadEmps()]);
    });

    // ---- сотрудники

    function openEmp(e) {
      editingEmp = e || null;
      empForm.reset();
      clearFormErrors(empForm);
      setFormMode(empForm, e ? 'edit' : 'create');
      $('dlg-emp-title').textContent = e ? 'Сотрудник ' + (e.displayName || e.login) : 'Новый сотрудник';
      limitPlaceholders(empForm);
      const items = depts
        .filter((d) => d.enabled || (e && String(d.id) === String(e.departmentId)))
        .map((d) => ({ value: d.id, label: d.name + (d.enabled ? '' : ' (выключен)') }));
      fillSelect(fe(empForm, 'departmentId'), items, {
        empty: '— выберите отдел —',
        value: e ? e.departmentId : filter.value,
      });
      if (e) {
        fset(empForm, 'login', e.login);
        fset(empForm, 'displayName', e.displayName);
        fset(empForm, 'email', e.email);
        fset(empForm, 'maxConcurrency', e.maxConcurrency);
        fset(empForm, 'maxPending', e.maxPending);
        fset(empForm, 'enabled', e.enabled);
      }
      openDialog(empDlg);
      fe(empForm, e ? 'displayName' : 'login').focus();
    }

    async function toggleEmp(e) {
      if (e.enabled && !window.confirm(`Выключить сотрудника «${e.displayName || e.login}»?`)) return;
      await api('PATCH', '/employees/' + enc(e.id), { enabled: !e.enabled });
      toast(e.enabled ? 'Сотрудник выключен' : 'Сотрудник включён');
      await Promise.all([loadDepts(), loadEmps()]);
    }

    onSubmit(empForm, async () => {
      const issues = [];
      const deptId = fval(empForm, 'departmentId');
      const email = fval(empForm, 'email');
      const next = {
        displayName: fval(empForm, 'displayName'),
        email: email || null,
        departmentId: deptId ? idVal(deptId) : null,
        maxConcurrency: readInt(empForm, 'maxConcurrency', 1, issues),
        maxPending: readInt(empForm, 'maxPending', 0, issues),
      };
      if (!next.displayName) issues.push({ path: 'displayName', message: 'Укажите имя' });
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) issues.push({ path: 'email', message: 'Некорректный email' });
      if (!deptId) issues.push({ path: 'departmentId', message: 'Выберите отдел' });
      if (editingEmp) {
        next.enabled = fchecked(empForm, 'enabled');
        throwIfIssues(issues);
        const body = diff(editingEmp, next);
        if (!Object.keys(body).length) { empDlg.close(); toast('Изменений нет'); return; }
        await api('PATCH', '/employees/' + enc(editingEmp.id), body);
        toast('Сотрудник сохранён');
      } else {
        const login = fval(empForm, 'login');
        if (!login) issues.push({ path: 'login', message: 'Укажите логин' });
        throwIfIssues(issues);
        await api('POST', '/employees', Object.assign({ login }, compact(next)));
        toast('Сотрудник создан');
      }
      empDlg.close();
      await Promise.all([loadDepts(), loadEmps()]);
    });

    filter.addEventListener('change', () => { loadEmps(); });
    $('btn-dept-add').addEventListener('click', () => openDept(null));
    $('btn-emp-add').addEventListener('click', () => {
      if (!depts.some((d) => d.enabled)) { toast('Сначала создайте отдел', true); return; }
      openEmp(null);
    });
    const reloadBtn = $('btn-dir-reload');
    reloadBtn.addEventListener('click', () => busy(reloadBtn, loadAll));
    await loadAll();
  }

  // ================================================================
  // Страница: провайдеры
  // ================================================================

  const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

  function parseHeaders(text, issues) {
    const out = {};
    const seen = new Set();
    String(text).split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const idx = line.indexOf(':');
      const name = idx > 0 ? line.slice(0, idx).trim() : '';
      const value = idx > 0 ? line.slice(idx + 1).trim() : '';
      if (!name || !HEADER_NAME_RE.test(name)) {
        issues.push({ path: 'extraHeaders', message: `Строка ${i + 1}: нужен формат «Имя: значение»` });
        return;
      }
      if (!value) {
        issues.push({ path: 'extraHeaders', message: `Строка ${i + 1}: пустое значение заголовка ${name}` });
        return;
      }
      const lower = name.toLowerCase();
      if (seen.has(lower)) {
        issues.push({ path: 'extraHeaders', message: `Заголовок ${name} указан дважды` });
        return;
      }
      seen.add(lower);
      out[name] = value;
    });
    return out;
  }

  async function pageProviders() {
    const tbody = $('prov-tbody');
    const form = $('form-prov');
    const dlg = $('dlg-prov');
    const tests = new Map();
    let providers = [];
    let editing = null;
    let headersInitial = '';

    async function load() {
      hideBanner('prov-error');
      try {
        providers = ((await api('GET', '/providers')) || {}).providers || [];
      } catch (err) {
        showBanner('prov-error', err);
        return;
      }
      render();
    }

    function testResultNode(t) {
      if (t.pending) return muted('Проверка соединения…');
      if (t.error) return [badge('ошибка', 'err'), ' ', t.error];
      const r = t.result || {};
      const info = [];
      if (r.httpStatus !== null && r.httpStatus !== undefined) info.push('HTTP ' + r.httpStatus);
      if (r.latencyMs !== null && r.latencyMs !== undefined) info.push(fmtMsDur(r.latencyMs));
      if (r.modelsCount !== null && r.modelsCount !== undefined) info.push('моделей: ' + fmtInt(r.modelsCount));
      return [
        r.ok ? badge('доступен', 'ok') : badge('ошибка', 'err'),
        ' ', info.join(' · '),
        muted(' · проверено в ' + fmtDate(t.at).slice(11)),
        r.error ? h('div', { class: 'error-text' }, errText(r.error)) : null,
        Array.isArray(r.sampleModels) && r.sampleModels.length
          ? h('div', { class: 'muted small mono' }, 'например: ' + r.sampleModels.join(', '))
          : null,
      ];
    }

    function render() {
      const rows = [];
      for (const p of providers) {
        const t = tests.get(p.id);
        const names = Array.isArray(p.extraHeaderNames) ? p.extraHeaderNames : [];
        rows.push(h('tr', { class: p.enabled ? null : 'row-off' },
          td([h('div', { class: 'strong' }, p.name), p.isDefault ? badge('глобальный дефолт', 'info') : null]),
          td(h('span', { class: 'mono break' }, p.baseUrl)),
          td(p.hasApiKey ? mono(p.apiKeyFp || 'задан', 'Отпечаток ключа') : muted('нет')),
          td(names.length ? mono(names.join(', ')) : muted('—')),
          td(mono(p.usageMode)),
          td(p.maxConcurrency !== null && p.maxConcurrency !== undefined ? fmtInt(p.maxConcurrency) : muted('не задан'), 'num'),
          td(statusOnOff(p.enabled)),
          td(fmtInt(p.activeTokens), 'num'),
          td(h('div', { class: 'actions' },
            actionBtn('Изменить', () => openForm(p)),
            actionBtn('Проверить', () => test(p), null, !!(t && t.pending)),
            actionBtn(p.enabled ? 'Выключить' : 'Включить', () => toggle(p), p.enabled ? 'btn-danger' : null)))));
        if (t) rows.push(h('tr', { class: 'subrow' }, h('td', { colspan: 9 }, testResultNode(t))));
      }
      setRows(tbody, rows, 9, 'Провайдеров пока нет');
    }

    async function test(p) {
      const cur = tests.get(p.id);
      if (cur && cur.pending) return;
      tests.set(p.id, { pending: true });
      render();
      try {
        const r = await api('POST', `/providers/${enc(p.id)}/test`);
        tests.set(p.id, { result: r || {}, at: Date.now() });
      } catch (err) {
        tests.set(p.id, { error: friendlyError(err), at: Date.now() });
      }
      render();
    }

    async function toggle(p) {
      if (p.enabled) {
        const extra = [];
        if (p.activeTokens) extra.push(`к нему привязано активных ключей: ${p.activeTokens}`);
        if (p.isDefault) extra.push('он выбран глобальным дефолтом');
        const msg = `Выключить провайдера «${p.name}»?` + (extra.length ? ' Внимание: ' + extra.join('; ') + '.' : '');
        if (!window.confirm(msg)) return;
      }
      await api('PATCH', '/providers/' + enc(p.id), { enabled: !p.enabled });
      toast(p.enabled ? 'Провайдер выключен' : 'Провайдер включён');
      await load();
    }

    fe(form, 'removeApiKey').addEventListener('change', (ev) => {
      const key = fe(form, 'apiKey');
      key.disabled = ev.target.checked;
      if (ev.target.checked) key.value = '';
    });

    function openForm(p) {
      editing = p || null;
      form.reset();
      clearFormErrors(form);
      setFormMode(form, p ? 'edit' : 'create');
      $('dlg-prov-title').textContent = p ? 'Провайдер ' + p.name : 'Новый провайдер';
      const key = fe(form, 'apiKey');
      key.disabled = false;
      key.placeholder = p && p.hasApiKey ? 'оставьте пустым, чтобы не менять' : '';
      $('prov-apiKey-hint').textContent = p
        ? (p.hasApiKey
          ? `Задан ключ (${p.apiKeyFp || 'отпечаток неизвестен'}). Оставьте пустым, чтобы не менять.`
          : 'Ключ не задан. Оставьте пустым, чтобы не задавать.')
        : 'Необязательно.';
      $('prov-removeKey-row').classList.toggle('hidden', !(p && p.hasApiKey));
      const names = p && Array.isArray(p.extraHeaderNames) ? p.extraHeaderNames : [];
      $('prov-extraHeaders-hint').textContent = p
        ? (names.length
          ? `Сейчас заданы: ${names.join(', ')}. Значения не показываются. Чтобы изменить, введите все заголовки заново — список заменится целиком; пустое поле — не менять.`
          : 'Сейчас заголовков нет.')
        : 'Необязательно.';
      $('prov-clearHeaders-row').classList.toggle('hidden', !names.length);
      if (p) {
        fset(form, 'name', p.name);
        fset(form, 'baseUrl', p.baseUrl);
        fset(form, 'usageMode', p.usageMode || 'auto');
        fset(form, 'maxConcurrency', p.maxConcurrency);
        fset(form, 'enabled', p.enabled);
      } else {
        fset(form, 'usageMode', 'auto');
      }
      headersInitial = fe(form, 'extraHeaders').value;
      openDialog(dlg);
      fe(form, 'name').focus();
    }

    onSubmit(form, async () => {
      const issues = [];
      const next = {
        name: fval(form, 'name'),
        baseUrl: fval(form, 'baseUrl'),
        usageMode: fval(form, 'usageMode') || 'auto',
        maxConcurrency: readInt(form, 'maxConcurrency', 1, issues),
      };
      if (!next.name) issues.push({ path: 'name', message: 'Укажите название' });
      if (!next.baseUrl) issues.push({ path: 'baseUrl', message: 'Укажите Base URL' });
      else if (!/^https?:\/\/[^\s/]+/i.test(next.baseUrl)) issues.push({ path: 'baseUrl', message: 'Нужен адрес вида https://host/path' });
      const headersText = fe(form, 'extraHeaders').value;
      const headersChanged = headersText !== headersInitial && headersText.trim() !== '';
      const headers = headersChanged ? parseHeaders(headersText, issues) : null;
      const key = fe(form, 'apiKey').value.trim();

      if (editing) {
        next.enabled = fchecked(form, 'enabled');
        throwIfIssues(issues);
        const body = diff(editing, next);
        if (fchecked(form, 'removeApiKey')) body.apiKey = null;
        else if (key) body.apiKey = key;
        if (headers) body.extraHeaders = headers;
        else if (fchecked(form, 'clearHeaders')) body.extraHeaders = {};
        if (!Object.keys(body).length) { dlg.close(); toast('Изменений нет'); return; }
        await api('PATCH', '/providers/' + enc(editing.id), body);
        tests.delete(editing.id);
        toast('Провайдер сохранён');
      } else {
        throwIfIssues(issues);
        const body = compact(next);
        if (key) body.apiKey = key;
        if (headers) body.extraHeaders = headers;
        await api('POST', '/providers', body);
        toast('Провайдер создан');
      }
      dlg.close();
      await load();
    });

    $('btn-prov-add').addEventListener('click', () => openForm(null));
    const reloadBtn = $('btn-prov-reload');
    reloadBtn.addEventListener('click', () => busy(reloadBtn, load));
    await load();
  }

  // ================================================================
  // Страница: агентские ключи
  // ================================================================

  function agentTokenStatus(t) {
    if (t.revokedAt) return badge('отозван', 'off');
    if (t.expiresAt && toMs(t.expiresAt) < Date.now()) return badge('истёк', 'warn');
    if (!t.enabled) return badge('выключен', 'off');
    return badge('активен', 'ok');
  }

  function agentOwnerText(t) {
    if (t.principalType === 'employee') {
      const who = t.employeeName || t.employeeLogin || ('#' + t.employeeId);
      return `${who}${t.employeeLogin ? ' (' + t.employeeLogin + ')' : ''}, отдел «${t.departmentName || '—'}»`;
    }
    return `отдел «${t.departmentName || '—'}» целиком`;
  }

  async function pageAgentTokens() {
    const ff = $('form-at-filter');
    const form = $('form-at');
    const dlg = $('dlg-at');
    const tbody = $('at-tbody');
    const params = new URLSearchParams(location.search);
    let tokens = [];
    let depts = [];
    let emps = [];
    let providers = [];
    let baseUrl = '';
    let editing = null;

    const refFail = (what) => (err) => { toast(`Не загружен список «${what}»: ${friendlyError(err)}`, true); return {}; };
    const [dr, er, pr] = await Promise.all([
      api('GET', '/departments').catch(refFail('отделы')),
      api('GET', '/employees').catch(refFail('сотрудники')),
      api('GET', '/providers').catch(refFail('провайдеры')),
    ]);
    depts = (dr && dr.departments) || [];
    emps = (er && er.employees) || [];
    providers = (pr && pr.providers) || [];

    // ---- фильтр

    function fillFilterEmps() {
      const dep = fval(ff, 'departmentId');
      const list = emps.filter((e) => !dep || String(e.departmentId) === dep);
      fillSelect(fe(ff, 'employeeId'), list.map((e) => ({ value: e.id, label: empLabel(e) })), { empty: 'Все сотрудники' });
    }

    fillSelect(fe(ff, 'departmentId'),
      depts.map((d) => ({ value: d.id, label: d.name + (d.enabled ? '' : ' (выключен)') })),
      { empty: 'Все отделы', value: params.get('departmentId') || '' });
    fillFilterEmps();
    selectValue(fe(ff, 'employeeId'), params.get('employeeId') || '');
    fe(ff, 'includeRevoked').checked = params.get('includeRevoked') === '1';
    fe(ff, 'departmentId').addEventListener('change', fillFilterEmps);

    async function load() {
      hideBanner('at-error');
      const q = qs({
        departmentId: fval(ff, 'departmentId'),
        employeeId: fval(ff, 'employeeId'),
        includeRevoked: fchecked(ff, 'includeRevoked') ? '1' : '',
      });
      let r;
      try {
        r = (await api('GET', '/agent-tokens' + q)) || {};
      } catch (err) {
        showBanner('at-error', err);
        return;
      }
      tokens = r.tokens || [];
      baseUrl = r.agentBaseUrl || '';
      $('at-base-url').textContent = baseUrl || '—';
      history.replaceState(null, '', location.pathname + q);
      render();
    }

    function modelCell(t) {
      if (!t.effective) return badge('не назначена', 'warn');
      return [
        h('div', null, `${t.effective.providerName || '—'} / `, h('span', { class: 'mono' }, t.effective.model || '—')),
        t.effective.origin === 'global_default' ? h('div', { class: 'muted small' }, 'по умолчанию') : null,
      ];
    }

    function ownerCell(t) {
      if (t.principalType === 'employee') {
        return [
          h('div', null, t.employeeName || t.employeeLogin || ('#' + t.employeeId)),
          h('div', { class: 'muted small' }, (t.employeeLogin ? t.employeeLogin + ' · ' : '') + (t.departmentName || '—')),
        ];
      }
      return [h('div', null, t.departmentName || '—'), h('div', { class: 'muted small' }, 'отдел целиком')];
    }

    function render() {
      setRows(tbody, tokens.map((t) => {
        const live = !t.revokedAt;
        return h('tr', { class: live && t.enabled ? null : 'row-off' },
          td(mono((t.prefix || '') + '…')),
          td(t.label || '—'),
          td(ownerCell(t)),
          td(modelCell(t)),
          td(t.expiresAt ? fmtDate(t.expiresAt) : muted('бессрочно'), 'nowrap'),
          td(Array.isArray(t.allowedCidrs) && t.allowedCidrs.length ? mono(t.allowedCidrs.join(', ')) : muted('любые')),
          td(agentTokenStatus(t)),
          td(fmtDate(t.createdAt), 'nowrap'),
          td(fmtDate(t.lastUsedAt), 'nowrap'),
          td(live ? h('div', { class: 'actions' },
            actionBtn('Изменить', () => openForm(t)),
            actionBtn(t.enabled ? 'Выключить' : 'Включить', () => toggle(t)),
            actionBtn('Отозвать', () => revoke(t), 'btn-danger')) : null));
      }), 10, 'Ключей не найдено');
    }

    async function toggle(t) {
      await api('PATCH', '/agent-tokens/' + enc(t.id), { enabled: !t.enabled });
      toast(t.enabled ? 'Ключ выключен' : 'Ключ включён');
      await load();
    }

    async function revoke(t) {
      const name = (t.prefix || '') + '…' + (t.label ? ` («${t.label}»)` : '');
      if (!window.confirm(`Отозвать ключ ${name}? Отзыв необратим: агент с этим ключом перестанет работать.`)) return;
      await api('POST', `/agent-tokens/${enc(t.id)}/revoke`);
      toast('Ключ отозван');
      await load();
    }

    // ---- форма выпуска / редактирования

    function fillProviderSelect(currentId) {
      const items = providers
        .filter((p) => p.enabled || String(p.id) === String(currentId))
        .map((p) => ({ value: p.id, label: p.name + (p.enabled ? '' : ' (выключен)') }));
      if (currentId !== null && currentId !== undefined && !items.some((i) => String(i.value) === String(currentId))) {
        items.push({ value: currentId, label: `#${currentId} (не найден)` });
      }
      fillSelect(fe(form, 'providerId'), items, { empty: '— глобальный дефолт —', value: currentId == null ? '' : currentId });
    }

    function fillFormEmps(preferId) {
      const dep = fval(form, 'departmentId');
      const list = dep ? emps.filter((e) => String(e.departmentId) === dep && e.enabled) : [];
      fillSelect(fe(form, 'employeeId'), list.map((e) => ({ value: e.id, label: empLabel(e) })), {
        empty: dep ? (list.length ? '— выберите сотрудника —' : '— нет активных сотрудников —') : '— сначала выберите отдел —',
        value: preferId == null ? '' : preferId,
      });
    }

    function syncPrincipal() {
      const show = form.dataset.mode === 'create' && fval(form, 'principalType') === 'employee';
      $('at-employee-row').classList.toggle('hidden', !show);
    }

    fe(form, 'principalType').addEventListener('change', syncPrincipal);
    fe(form, 'departmentId').addEventListener('change', () => fillFormEmps(null));

    function openForm(t) {
      editing = t || null;
      form.reset();
      clearFormErrors(form);
      setFormMode(form, t ? 'edit' : 'create');
      $('dlg-at-title').textContent = t ? `Ключ ${t.prefix || ''}…` : 'Новый агентский ключ';
      const exp = fe(form, 'expiresAt');
      exp.min = toLocalInput(Date.now());
      if (t) {
        $('at-owner').textContent = agentOwnerText(t);
        fset(form, 'label', t.label);
        fillProviderSelect(t.providerId);
        fset(form, 'model', t.model);
        fset(form, 'expiresAt', t.expiresAt ? toLocalInput(t.expiresAt) : '');
        fset(form, 'allowedCidrs', Array.isArray(t.allowedCidrs) ? t.allowedCidrs.join('\n') : '');
        fset(form, 'enabled', t.enabled);
      } else {
        const filterDept = fval(ff, 'departmentId');
        const filterEmp = fval(ff, 'employeeId');
        const emp = filterEmp ? emps.find((e) => String(e.id) === filterEmp) : null;
        fillSelect(fe(form, 'departmentId'),
          depts.filter((d) => d.enabled).map((d) => ({ value: d.id, label: d.name })),
          { empty: '— выберите отдел —', value: emp ? emp.departmentId : filterDept });
        fillFormEmps(emp ? emp.id : null);
        fset(form, 'principalType', 'employee');
        fillProviderSelect(null);
      }
      syncPrincipal();
      openDialog(dlg);
      fe(form, t ? 'label' : 'principalType').focus();
    }

    onSubmit(form, async () => {
      const issues = [];
      const providerId = fval(form, 'providerId');
      const model = fval(form, 'model');
      if (providerId && !model) issues.push({ path: 'model', message: 'Укажите модель для выбранного провайдера' });
      if (!providerId && model) issues.push({ path: 'providerId', message: 'Выберите провайдера для этой модели' });

      const expStr = fval(form, 'expiresAt');
      let expiresAt = null;
      if (expStr) {
        if (editing && editing.expiresAt && expStr === toLocalInput(editing.expiresAt)) {
          expiresAt = editing.expiresAt; // не трогали — не теряем секунды исходного значения
        } else {
          const ms = new Date(expStr).getTime();
          if (!Number.isFinite(ms)) issues.push({ path: 'expiresAt', message: 'Некорректная дата' });
          else if (ms <= Date.now()) issues.push({ path: 'expiresAt', message: 'Дата должна быть в будущем' });
          else expiresAt = ms;
        }
      }
      const cidrs = lines(fe(form, 'allowedCidrs').value);
      const bad = cidrs.find((c) => !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(c));
      if (bad) issues.push({ path: 'allowedCidrs', message: `Не похоже на IP/CIDR: ${bad}` });
      const label = fval(form, 'label');

      if (editing) {
        const orig = {
          label: editing.label || null,
          expiresAt: editing.expiresAt || null,
          allowedCidrs: Array.isArray(editing.allowedCidrs) && editing.allowedCidrs.length ? editing.allowedCidrs : null,
          enabled: editing.enabled,
        };
        const next = {
          label: label || null,
          expiresAt,
          allowedCidrs: cidrs.length ? cidrs : null,
          enabled: fchecked(form, 'enabled'),
        };
        throwIfIssues(issues);
        const body = diff(orig, next);
        const pid = providerId ? idVal(providerId) : null;
        const mdl = model || null;
        const origPid = editing.providerId === undefined ? null : editing.providerId;
        if (String(pid === null ? '' : pid) !== String(origPid === null ? '' : origPid) || mdl !== (editing.model || null)) {
          body.providerId = pid;
          body.model = mdl;
        }
        if (!Object.keys(body).length) { dlg.close(); toast('Изменений нет'); return; }
        await api('PATCH', '/agent-tokens/' + enc(editing.id), body);
        dlg.close();
        toast('Ключ сохранён');
      } else {
        const principalType = fval(form, 'principalType');
        const departmentId = fval(form, 'departmentId');
        const employeeId = fval(form, 'employeeId');
        const body = { principalType };
        if (!departmentId) issues.push({ path: 'departmentId', message: 'Выберите отдел' });
        if (principalType === 'employee') {
          if (!employeeId) issues.push({ path: 'employeeId', message: 'Выберите сотрудника' });
          else body.employeeId = idVal(employeeId);
        } else if (departmentId) {
          body.departmentId = idVal(departmentId);
        }
        if (label) body.label = label;
        if (providerId && model) { body.providerId = idVal(providerId); body.model = model; }
        if (expiresAt !== null) body.expiresAt = expiresAt;
        if (cidrs.length) body.allowedCidrs = cidrs;
        throwIfIssues(issues);
        const res = await api('POST', '/agent-tokens', body);
        dlg.close();
        showSecret('Агентский ключ выпущен', res && res.plaintext, cursorHint(baseUrl));
      }
      await load();
    });

    onSubmit(ff, load);
    $('btn-at-add').addEventListener('click', () => {
      if (!depts.some((d) => d.enabled)) { toast('Сначала создайте отдел в справочнике', true); return; }
      openForm(null);
    });
    await load();
  }

  // ================================================================
  // Страница: настройки
  // ================================================================

  async function pageSettings() {
    const form = $('form-agent-defaults');
    const pw = $('form-password');
    let settings = null;
    let providers = [];

    function fill() {
      const d = settings.agentDefaults || {};
      const env = settings.env || {};
      const items = providers
        .filter((p) => p.enabled || String(p.id) === String(d.providerId))
        .map((p) => ({ value: p.id, label: p.name + (p.enabled ? '' : ' (выключен)') }));
      if (d.providerId !== null && d.providerId !== undefined && !items.some((i) => String(i.value) === String(d.providerId))) {
        items.push({ value: d.providerId, label: `#${d.providerId} (не найден)` });
      }
      fillSelect(fe(form, 'providerId'), items, { empty: '— не задан —', value: d.providerId == null ? '' : d.providerId });
      fset(form, 'model', d.model);
      fset(form, 'maxConcurrency', d.maxConcurrency);
      fset(form, 'maxPending', d.maxPending);
      fe(form, 'maxConcurrency').placeholder = 'из окружения: ' + fmtInt(env.agentPrincipalMaxConcurrency);
      fe(form, 'maxPending').placeholder = 'из окружения: ' + fmtInt(env.agentPrincipalMaxPending);
      $('set-maxConcurrency-hint').textContent = `Пусто — значение окружения (${fmtInt(env.agentPrincipalMaxConcurrency)}).`;
      $('set-maxPending-hint').textContent = `Пусто — значение окружения (${fmtInt(env.agentPrincipalMaxPending)}).`;
    }

    function renderEnv() {
      const env = settings.env || {};
      const rows = [
        ['Base URL для агентов', 'agentBaseUrl', mono(settings.agentBaseUrl)],
        ['Одновременных запросов на владельца', 'agentPrincipalMaxConcurrency', fmtInt(env.agentPrincipalMaxConcurrency)],
        ['Очередь на владельца', 'agentPrincipalMaxPending', fmtInt(env.agentPrincipalMaxPending)],
        ['Общая конкурентность агентского контура', 'agentQueueConcurrency', fmtInt(env.agentQueueConcurrency)],
        ['Общая очередь агентского контура', 'agentQueueMaxPending', fmtInt(env.agentQueueMaxPending)],
        ['Rate limit: запросов за окно', 'agentRateLimitMax', fmtInt(env.agentRateLimitMax)],
        ['Rate limit: окно', 'agentRateLimitWindowMs', fmtMsDur(env.agentRateLimitWindowMs)],
      ].map(([label, key, value]) => h('tr', null,
        h('th', { scope: 'row' }, label, h('span', { class: 'mono small' }, key)),
        td(value)));
      $('set-env-tbody').replaceChildren(...rows);
    }

    try {
      const [s, p] = await Promise.all([
        api('GET', '/settings'),
        api('GET', '/providers').catch((err) => { toast('Список провайдеров не загружен: ' + friendlyError(err), true); return {}; }),
      ]);
      settings = s || {};
      providers = (p && p.providers) || [];
      fill();
      renderEnv();
    } catch (err) {
      showFormErrors(form, err);
      setRows($('set-env-tbody'), [], 2, 'Не удалось загрузить');
    }

    onSubmit(form, async () => {
      if (!settings) throw validationError([{ path: '', message: 'Настройки не загружены — обновите страницу' }]);
      const issues = [];
      const providerId = fval(form, 'providerId');
      const model = fval(form, 'model');
      if (providerId && !model) issues.push({ path: 'model', message: 'Укажите модель для выбранного провайдера' });
      if (!providerId && model) issues.push({ path: 'providerId', message: 'Выберите провайдера для этой модели' });
      const body = {
        providerId: providerId ? idVal(providerId) : null,
        model: model || null,
        maxConcurrency: readInt(form, 'maxConcurrency', 1, issues),
        maxPending: readInt(form, 'maxPending', 0, issues),
      };
      throwIfIssues(issues);
      const r = await api('PUT', '/settings/agent-defaults', body);
      if (r && r.agentDefaults) settings.agentDefaults = r.agentDefaults;
      else settings.agentDefaults = body;
      fill();
      toast('Настройки сохранены');
    });

    onSubmit(pw, async () => {
      const current = fe(pw, 'current').value;
      const next = fe(pw, 'next').value;
      const next2 = fe(pw, 'next2').value;
      const issues = [];
      if (!current) issues.push({ path: 'current', message: 'Введите текущий пароль' });
      if (next.length < 12) issues.push({ path: 'next', message: 'Не короче 12 символов' });
      else if (next === current) issues.push({ path: 'next', message: 'Новый пароль совпадает с текущим' });
      if (next2 !== next) issues.push({ path: 'next2', message: 'Пароли не совпадают' });
      throwIfIssues(issues);
      try {
        await api('POST', '/auth/change-password', { current, next });
      } catch (err) {
        if (err.code === 'invalid_credentials' || err.code === 'invalid_password' || err.code === 'wrong_password') {
          err.display = 'Неверный текущий пароль';
          err.issues = [{ path: 'current', message: 'Неверный текущий пароль' }];
        }
        throw err;
      }
      pw.reset();
      toast('Пароль изменён. Войдите заново.');
      setTimeout(() => location.replace('/admin/login'), 1500);
    });
  }

  // ================================================================
  // Страница: статистика
  // ================================================================

  const CONTOUR_GROUPINGS = new Set(['client', 'model', 'day-client']);

  async function pageStats() {
    const form = $('form-stats');
    const params = new URLSearchParams(location.search);
    const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
    fset(form, 'from', isDay(params.get('from')) ? params.get('from') : isoDay(from));
    fset(form, 'to', isDay(params.get('to')) ? params.get('to') : isoDay(today));
    if (params.get('by')) selectValue(fe(form, 'by'), params.get('by'));
    if (params.get('contour')) selectValue(fe(form, 'contour'), params.get('contour'));

    function syncContour() {
      const sel = fe(form, 'contour');
      const allowed = CONTOUR_GROUPINGS.has(fval(form, 'by'));
      sel.disabled = !allowed;
      if (!allowed) sel.value = '';
    }
    fe(form, 'by').addEventListener('change', syncContour);
    syncContour();

    function totalsRow(label, x, cls, title) {
      return h('tr', cls ? { class: cls } : null,
        h('td', { title }, label),
        td(fmtInt(x.executions), 'num'),
        td(fmtInt(x.upstream_attempts), 'num'),
        td(fmtInt(x.input_tokens), 'num'),
        td(fmtInt(x.output_tokens), 'num'),
        td(fmtMoney(x.cost_actual_usd), 'num'),
        h('td', { class: 'num', title: x.approx_rows ? `оценённых попыток: ${x.approx_rows}` : null }, fmtMoney(x.cost_approx_usd)),
        td(fmtInt(x.missing_rows), x.missing_rows > 0 ? 'num warn-text' : 'num'));
    }

    function render(r) {
      const rows = r.rows || [];
      $('stats-meta').textContent = `Период: ${r.from || '—'} — ${r.to || '—'}` +
        (r.timezone ? ` · часовой пояс: ${r.timezone}` : '') + ` · строк: ${fmtInt(rows.length)}`;
      setRows($('stats-tbody'), rows.map((x) => {
        const label = x.label !== null && x.label !== undefined && x.label !== '' ? String(x.label) : String(x.key == null ? '—' : x.key);
        return totalsRow(label, x, null, x.key != null && String(x.key) !== label ? 'ключ: ' + x.key : null);
      }), 8, 'Нет данных за период');
      $('stats-tfoot').replaceChildren(...(r.totals ? [totalsRow('Итого', r.totals)] : []));
    }

    onSubmit(form, async () => {
      const f = fval(form, 'from');
      const t = fval(form, 'to');
      const issues = [];
      if (!f) issues.push({ path: 'from', message: 'Укажите начало периода' });
      if (!t) issues.push({ path: 'to', message: 'Укажите конец периода' });
      if (f && t && f > t) issues.push({ path: 'to', message: 'Конец периода раньше начала' });
      throwIfIssues(issues);
      const contour = fe(form, 'contour').disabled ? '' : fval(form, 'contour');
      const q = qs({ from: f, to: t, by: fval(form, 'by'), contour });
      const r = await api('GET', '/stats/spend' + q);
      history.replaceState(null, '', location.pathname + q);
      render(r || {});
    });

    submitNow(form);
  }

  // ================================================================
  // Страница: запросы
  // ================================================================

  function requestStatusBadge(status) {
    if (status === 'success') return badge(status, 'ok');
    if (status === 'client_aborted') return badge(status, 'off');
    if (!status) return muted('—');
    return badge(String(status), 'err');
  }

  async function pageRequests() {
    const form = $('form-req-filter');
    const params = new URLSearchParams(location.search);
    let depts = [];
    let emps = [];

    const refFail = (err) => { toast('Справочник не загружен: ' + friendlyError(err), true); return {}; };
    const [dr, er] = await Promise.all([
      api('GET', '/departments').catch(refFail),
      api('GET', '/employees').catch(refFail),
    ]);
    depts = (dr && dr.departments) || [];
    emps = (er && er.employees) || [];

    function fillEmps() {
      const dep = fval(form, 'departmentId');
      const list = emps.filter((e) => !dep || String(e.departmentId) === dep);
      fillSelect(fe(form, 'employeeId'), list.map((e) => ({ value: e.id, label: empLabel(e) })), { empty: 'все' });
    }

    fillSelect(fe(form, 'departmentId'), depts.map((d) => ({ value: d.id, label: d.name })),
      { empty: 'все', value: params.get('departmentId') || '' });
    fillEmps();
    selectValue(fe(form, 'employeeId'), params.get('employeeId') || '');
    fe(form, 'departmentId').addEventListener('change', fillEmps);
    for (const k of ['contour', 'clientId', 'tokenId', 'limit']) {
      if (params.get(k)) fset(form, k, params.get(k));
    }

    function modelCell(r) {
      const req = r.model_requested;
      const used = r.model_used;
      if (req && used && req !== used) {
        return [mono(req), h('span', { class: 'muted' }, ' → '), mono(used)];
      }
      return mono(used || req);
    }

    const contourLabel = (c) => (c === 'site' ? 'сайт' : c === 'agent' ? 'агент' : (c || '—'));

    function render(list) {
      setRows($('req-tbody'), list.map((r) => h('tr', null,
        td(String(r.id), 'num'),
        h('td', { class: 'nowrap', title: r.request_id ? 'request_id: ' + r.request_id : null }, fmtDate(r.ts_received)),
        td(contourLabel(r.contour)),
        td(mono(r.client_id)),
        td(mono(r.token_id)),
        td(modelCell(r)),
        td([requestStatusBadge(r.status), r.dedup_join ? [' ', badge('dedup', 'warn')] : null], 'nowrap'),
        td(r.http_status === null || r.http_status === undefined ? '—' : String(r.http_status), 'num'),
        td(fmtMsDur(r.latency_ms), 'num'),
        td(fmtInt(r.input_tokens), 'num'),
        td(fmtInt(r.output_tokens), 'num'),
        td(fmtMoney(r.cost_actual_usd), 'num'),
        td(r.error_code ? h('span', { class: 'mono err-text' }, r.error_code) : '—'))),
      13, 'Запросов не найдено');
    }

    onSubmit(form, async () => {
      const q = qs({
        contour: fval(form, 'contour'),
        clientId: fval(form, 'clientId'),
        tokenId: fval(form, 'tokenId'),
        departmentId: fval(form, 'departmentId'),
        employeeId: fval(form, 'employeeId'),
        limit: fval(form, 'limit') || '100',
      });
      const r = await api('GET', '/requests' + q);
      history.replaceState(null, '', location.pathname + q);
      render((r && r.requests) || []);
    });

    submitNow(form);
  }

  // ================================================================
  // Страница: аудит
  // ================================================================

  async function pageAudit() {
    const tbody = $('audit-tbody');
    const more = $('btn-audit-more');
    const reload = $('btn-audit-reload');
    const LIMIT = 100;
    let lastId = null;

    function row(e) {
      const entity = (e.entityType || '—') + (e.entityId !== null && e.entityId !== undefined && e.entityId !== '' ? ' #' + e.entityId : '');
      return h('tr', null,
        td(String(e.id), 'num'),
        td(fmtDate(e.ts), 'nowrap'),
        td(e.adminLogin || '—'),
        td(mono(e.ip)),
        td(mono(e.action)),
        td(entity),
        td(e.details ? h('details', null,
          h('summary', null, 'показать'),
          h('pre', null, JSON.stringify(e.details, null, 2))) : '—'));
    }

    async function load(reset) {
      hideBanner('audit-error');
      let r;
      try {
        r = (await api('GET', '/audit' + qs({ limit: LIMIT, beforeId: reset ? null : lastId }))) || {};
      } catch (err) {
        showBanner('audit-error', err);
        return;
      }
      const entries = r.entries || [];
      if (reset) {
        lastId = null;
        setRows(tbody, entries.map(row), 7, 'Записей нет');
      } else {
        entries.forEach((e) => tbody.appendChild(row(e)));
      }
      if (entries.length) lastId = entries[entries.length - 1].id;
      more.classList.toggle('hidden', entries.length < LIMIT);
    }

    more.addEventListener('click', () => busy(more, () => load(false)));
    reload.addEventListener('click', () => busy(reload, () => load(true)));
    await busy(reload, () => load(true));
  }

  // ================================================================
  // Запуск
  // ================================================================

  const PAGES = {
    home: pageHome,
    sites: pageSites,
    directory: pageDirectory,
    providers: pageProviders,
    'agent-tokens': pageAgentTokens,
    settings: pageSettings,
    stats: pageStats,
    requests: pageRequests,
    audit: pageAudit,
  };

  async function start() {
    initDialogs();
    const page = document.body.dataset.page || '';
    if (page === 'login') {
      try { await pageLogin(); } catch (err) { showFatal(err); }
      return;
    }

    let me;
    try {
      me = await loadMe();
    } catch (err) {
      showFatal(err);
      return;
    }
    const who = $('who');
    if (who && me && me.admin) {
      who.textContent = me.admin.login || '';
      if (me.admin.displayName) who.title = me.admin.displayName;
    }
    const logout = $('btn-logout');
    if (logout) {
      logout.addEventListener('click', async () => {
        logout.disabled = true;
        try { await api('POST', '/auth/logout'); } catch (_) { /* уходим в любом случае */ }
        location.replace('/admin/login');
      });
    }

    const mod = PAGES[page];
    if (mod) {
      try { await mod(); } catch (err) { showFatal(err); }
    }
  }

  window.addEventListener('unhandledrejection', (ev) => {
    console.error(ev.reason);
    toast(friendlyError(ev.reason), true);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
