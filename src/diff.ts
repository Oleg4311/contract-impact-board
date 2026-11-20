import { flatten, type Prop } from './schema.ts';
import { deref, operations, type Json, type Operation } from './spec.ts';

export type Level = 'error' | 'warn' | 'info';
export type Scope = 'operation' | 'request' | 'response' | 'parameter' | 'security';

/**
 * Одно изменение контракта. Идентификаторы правил совпадают с oasdiff (id), чтобы результаты можно было сверять.
 * Уровни: error — точно ломает клиента; warn — может сломать, зависит от клиента; info — безопасно.
 */
export interface Change {
  id: string;
  level: Level;
  operation: string; // «GET /users/{id}»
  scope: Scope;
  /** Путь свойства тела («data.items[].email») или «in:name» параметра. */
  path?: string;
  /** Код статуса ответа, если изменение относится к ответу. */
  status?: string;
  text: string;
}

const LEVEL_ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2 };

const mk = (c: Change): Change => c;

function isSuccess(status: string): boolean {
  return /^2/.test(status) || status === 'default' || status === '2XX' || status === '2xx';
}

/** Сравнивает две спецификации и возвращает изменения, отсортированные по важности. */
export function diffSpecs(oldDoc: Json, newDoc: Json): Change[] {
  const changes: Change[] = [];
  const oldOps = operations(oldDoc);
  const newOps = operations(newDoc);

  for (const [key, o] of oldOps) {
    const n = newOps.get(key);
    if (!n) {
      const pathGone = ![...newOps.values()].some((x) => x.path === o.path);
      const base = pathGone ? 'api-path-removed' : 'api-removed';
      changes.push(
        o.deprecated
          ? mk({ id: `${base}-with-deprecation`, level: 'info', operation: key, scope: 'operation', text: `${pathGone ? 'путь удалён' : 'операция удалена'} после объявления устаревшими` })
          : mk({ id: `${base}-without-deprecation`, level: 'error', operation: key, scope: 'operation', text: `${pathGone ? 'путь удалён' : 'операция удалена'} без предварительной пометки deprecated` }),
      );
      continue;
    }
    diffOperation(oldDoc, newDoc, o, n, changes);
  }
  for (const [key] of newOps) {
    if (!oldOps.has(key)) changes.push(mk({ id: 'endpoint-added', level: 'info', operation: key, scope: 'operation', text: 'добавлена операция' }));
  }

  return changes.sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.operation.localeCompare(b.operation) || a.id.localeCompare(b.id) || (a.path ?? '').localeCompare(b.path ?? ''),
  );
}

function diffOperation(oldDoc: Json, newDoc: Json, o: Operation, n: Operation, out: Change[]): void {
  const op = o.key;

  // --- безопасность ---
  for (const s of n.security) {
    if (!o.security.includes(s)) out.push(mk({ id: 'api-security-added', level: 'error', operation: op, scope: 'security', path: s, text: `добавлено требование безопасности «${s}»` }));
  }
  for (const s of o.security) {
    if (!n.security.includes(s)) out.push(mk({ id: 'api-security-removed', level: 'info', operation: op, scope: 'security', path: s, text: `убрано требование безопасности «${s}»` }));
  }

  // --- параметры ---
  for (const [k, p] of o.parameters) {
    const np = n.parameters.get(k);
    if (!np) {
      out.push(mk({ id: 'request-parameter-removed', level: 'warn', operation: op, scope: 'parameter', path: k, text: `удалён параметр ${p.in} «${p.name}»` }));
      continue;
    }
    if (!p.required && np.required) out.push(mk({ id: 'request-parameter-became-required', level: 'error', operation: op, scope: 'parameter', path: k, text: `параметр ${p.in} «${p.name}» стал обязательным` }));
    if (p.required && !np.required) out.push(mk({ id: 'request-parameter-became-optional', level: 'info', operation: op, scope: 'parameter', path: k, text: `параметр ${p.in} «${p.name}» стал необязательным` }));
    const ot = paramType(oldDoc, p);
    const nt = paramType(newDoc, np);
    if (ot !== nt) out.push(mk({ id: 'request-parameter-type-changed', level: 'error', operation: op, scope: 'parameter', path: k, text: `тип параметра ${p.in} «${p.name}» изменён: ${ot || '—'} → ${nt || '—'}` }));
    const oe = paramEnum(oldDoc, p);
    const ne = paramEnum(newDoc, np);
    if (oe && ne) {
      for (const v of oe) if (!ne.includes(v)) out.push(mk({ id: 'request-parameter-enum-value-removed', level: 'error', operation: op, scope: 'parameter', path: k, text: `у параметра «${p.name}» убрано допустимое значение «${v}»` }));
    }
  }
  for (const [k, np] of n.parameters) {
    if (o.parameters.has(k)) continue;
    if (np.required) {
      out.push(
        np.in === 'path'
          ? mk({ id: 'new-request-path-parameter', level: 'info', operation: op, scope: 'parameter', path: k, text: `добавлен параметр пути «${np.name}»` })
          : mk({ id: 'new-required-request-parameter', level: 'error', operation: op, scope: 'parameter', path: k, text: `добавлен обязательный параметр ${np.in} «${np.name}»` }),
      );
    } else out.push(mk({ id: 'new-optional-request-parameter', level: 'info', operation: op, scope: 'parameter', path: k, text: `добавлен необязательный параметр ${np.in} «${np.name}»` }));
  }

  // --- тело запроса ---
  const oBody = bodies(oldDoc, o.raw.requestBody);
  const nBody = bodies(newDoc, n.raw.requestBody);
  const oReq = deref(oldDoc, o.raw.requestBody)?.required === true;
  const nReq = deref(newDoc, n.raw.requestBody)?.required === true;
  if (!oReq && nReq) out.push(mk({ id: 'request-body-became-required', level: 'error', operation: op, scope: 'request', text: 'тело запроса стало обязательным' }));
  for (const [mt, oProps] of oBody) {
    const nProps = nBody.get(mt);
    if (!nProps) continue; // смену типов содержимого не разбираем
    diffRequestProps(op, oProps, nProps, out);
  }

  // --- ответы ---
  const oResp = responses(oldDoc, o.raw);
  const nResp = responses(newDoc, n.raw);
  for (const [status, oMedia] of oResp) {
    const nMedia = nResp.get(status);
    if (!nMedia) {
      out.push(
        isSuccess(status)
          ? mk({ id: 'response-success-status-removed', level: 'error', operation: op, scope: 'response', status, text: `убран успешный ответ ${status}` })
          : mk({ id: 'response-non-success-status-removed', level: 'warn', operation: op, scope: 'response', status, text: `убран ответ ${status}` }),
      );
      continue;
    }
    for (const [mt, oProps] of oMedia) {
      const nProps = nMedia.get(mt);
      if (!nProps) {
        out.push(mk({ id: 'response-media-type-removed', level: 'error', operation: op, scope: 'response', status, text: `для ответа ${status} убран тип содержимого ${mt}` }));
        continue;
      }
      diffResponseProps(op, status, oProps, nProps, out);
    }
  }
  for (const status of nResp.keys()) {
    if (oResp.has(status)) continue;
    out.push(
      isSuccess(status)
        ? mk({ id: 'response-success-status-added', level: 'info', operation: op, scope: 'response', status, text: `добавлен успешный ответ ${status}` })
        : mk({ id: 'response-non-success-status-added', level: 'info', operation: op, scope: 'response', status, text: `добавлен ответ ${status}` }),
    );
  }
}

function paramSchema(doc: Json, p: Json): Json {
  return deref(doc, p.schema ?? p.content?.['application/json']?.schema ?? {});
}
function paramType(doc: Json, p: Json): string {
  const s = paramSchema(doc, p);
  const t = Array.isArray(s.type) ? s.type.join('|') : (s.type ?? '');
  return s.format ? `${t}:${s.format}` : t;
}
function paramEnum(doc: Json, p: Json): string[] | undefined {
  const s = paramSchema(doc, p);
  return Array.isArray(s.enum) ? s.enum.map(String) : undefined;
}

/** Карта «тип содержимого → плоские свойства» для тела запроса. */
function bodies(doc: Json, body0: Json): Map<string, Map<string, Prop>> {
  const out = new Map<string, Map<string, Prop>>();
  const body = deref(doc, body0);
  for (const [mt, m] of Object.entries<Json>(body?.content ?? {})) out.set(mt, flatten(doc, m?.schema ?? {}));
  return out;
}

/** Карта «статус → тип содержимого → плоские свойства» для ответов. */
function responses(doc: Json, op: Json): Map<string, Map<string, Map<string, Prop>>> {
  const out = new Map<string, Map<string, Map<string, Prop>>>();
  for (const [status, r0] of Object.entries<Json>(op.responses ?? {})) {
    const r = deref(doc, r0);
    const media = new Map<string, Map<string, Prop>>();
    for (const [mt, m] of Object.entries<Json>(r?.content ?? {})) media.set(mt, flatten(doc, m?.schema ?? {}));
    out.set(status, media);
  }
  return out;
}

function diffRequestProps(op: string, o: Map<string, Prop>, n: Map<string, Prop>, out: Change[]): void {
  for (const [path, p] of o) {
    const q = n.get(path);
    if (!q) {
      // свойство удалено вместе с родителем — отдельно не сообщаем
      if (!hasMissingAncestor(path, n)) out.push(mk({ id: 'request-property-removed', level: 'warn', operation: op, scope: 'request', path, text: `из запроса удалено свойство «${path}»` }));
      continue;
    }
    if (!p.required && q.required) out.push(mk({ id: 'request-property-became-required', level: 'error', operation: op, scope: 'request', path, text: `свойство запроса «${path}» стало обязательным` }));
    if (p.required && !q.required) out.push(mk({ id: 'request-property-became-optional', level: 'info', operation: op, scope: 'request', path, text: `свойство запроса «${path}» стало необязательным` }));
    if (p.type !== q.type) out.push(mk({ id: 'request-property-type-changed', level: 'error', operation: op, scope: 'request', path, text: `тип свойства запроса «${path}» изменён: ${p.type || '—'} → ${q.type || '—'}` }));
    if (p.enum && q.enum) {
      for (const v of p.enum) if (!q.enum.includes(v)) out.push(mk({ id: 'request-property-enum-value-removed', level: 'error', operation: op, scope: 'request', path, text: `у свойства запроса «${path}» убрано значение «${v}»` }));
    }
  }
  for (const [path, q] of n) {
    if (o.has(path) || hasMissingAncestor(path, o)) continue;
    out.push(
      q.required
        ? mk({ id: 'new-required-request-property', level: 'error', operation: op, scope: 'request', path, text: `в запрос добавлено обязательное свойство «${path}»` })
        : mk({ id: 'new-optional-request-property', level: 'info', operation: op, scope: 'request', path, text: `в запрос добавлено необязательное свойство «${path}»` }),
    );
  }
}

function diffResponseProps(op: string, status: string, o: Map<string, Prop>, n: Map<string, Prop>, out: Change[]): void {
  for (const [path, p] of o) {
    const q = n.get(path);
    if (!q) {
      if (hasMissingAncestor(path, n)) continue;
      out.push(
        p.required
          ? mk({ id: 'response-required-property-removed', level: 'error', operation: op, scope: 'response', status, path, text: `из ответа ${status} удалено обязательное свойство «${path}»` })
          : mk({ id: 'response-optional-property-removed', level: 'warn', operation: op, scope: 'response', status, path, text: `из ответа ${status} удалено необязательное свойство «${path}»` }),
      );
      continue;
    }
    if (p.required && !q.required) out.push(mk({ id: 'response-property-became-optional', level: 'error', operation: op, scope: 'response', status, path, text: `свойство ответа ${status} «${path}» стало необязательным` }));
    if (p.type !== q.type) out.push(mk({ id: 'response-property-type-changed', level: 'error', operation: op, scope: 'response', status, path, text: `тип свойства ответа ${status} «${path}» изменён: ${p.type || '—'} → ${q.type || '—'}` }));
    if (p.enum && q.enum) {
      for (const v of q.enum) if (!p.enum.includes(v)) out.push(mk({ id: 'response-property-enum-value-added', level: 'warn', operation: op, scope: 'response', status, path, text: `в ответе ${status} у «${path}» появилось значение «${v}»` }));
      for (const v of p.enum) if (!q.enum.includes(v)) out.push(mk({ id: 'response-property-enum-value-removed', level: 'info', operation: op, scope: 'response', status, path, text: `в ответе ${status} у «${path}» пропало значение «${v}»` }));
    }
  }
  for (const [path, q] of n) {
    if (o.has(path) || hasMissingAncestor(path, o)) continue;
    out.push(
      q.required
        ? mk({ id: 'response-required-property-added', level: 'info', operation: op, scope: 'response', status, path, text: `в ответ ${status} добавлено обязательное свойство «${path}»` })
        : mk({ id: 'response-optional-property-added', level: 'info', operation: op, scope: 'response', status, path, text: `в ответ ${status} добавлено необязательное свойство «${path}»` }),
    );
  }
}

function parentPath(path: string): string | null {
  if (path.endsWith('[]')) return path.slice(0, -2) || null;
  const cut = path.lastIndexOf('.');
  return cut > 0 ? path.slice(0, cut) : null;
}

/** true, если какой-то предок пути отсутствует в карте (тогда изменение уже учтено на уровне родителя). */
function hasMissingAncestor(path: string, props: Map<string, Prop>): boolean {
  for (let p = parentPath(path); p !== null; p = parentPath(p)) if (!props.has(p)) return true;
  return false;
}
