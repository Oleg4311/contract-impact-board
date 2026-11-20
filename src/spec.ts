import { parse } from 'yaml';

/** Минимальная модель OpenAPI 3.x: нам нужны только пути, операции, параметры, тела и схемы. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export class SpecError extends Error {}

/** Разбирает YAML или JSON; бросает SpecError с понятным сообщением. */
export function parseSpec(text: string, label = 'схема'): Json {
  let doc: Json;
  try {
    doc = parse(text);
  } catch (e) {
    throw new SpecError(`${label}: не удалось разобрать YAML/JSON — ${(e as Error).message.split('\n')[0]}`);
  }
  if (!doc || typeof doc !== 'object') throw new SpecError(`${label}: пустой или не объект`);
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new SpecError(`${label}: поддерживается только OpenAPI 3.x (поле openapi: ${JSON.stringify(doc.openapi)})`);
  }
  if (!doc.paths || typeof doc.paths !== 'object') throw new SpecError(`${label}: нет раздела paths`);
  return doc;
}

/** Раскрывает локальные ссылки вида #/components/... Внешние ссылки не поддерживаются. */
export function deref(doc: Json, node: Json, seen: Set<string> = new Set()): Json {
  let cur = node;
  let guard = 0;
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    const ref: string = cur.$ref;
    if (!ref.startsWith('#/')) throw new SpecError(`внешние ссылки не поддерживаются: ${ref}`);
    if (seen.has(ref) || ++guard > 50) return {}; // цикл: считаем схему пустой
    seen.add(ref);
    const target = ref
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((acc: Json, key) => acc?.[key], doc);
    if (target === undefined) throw new SpecError(`ссылка не найдена: ${ref}`);
    cur = target;
  }
  return cur;
}

export interface Operation {
  key: string; // «GET /users/{id}»
  path: string;
  method: string;
  raw: Json;
  deprecated: boolean;
  parameters: Map<string, Json>; // «query:limit» → параметр (уже без $ref)
  security: string[]; // имена схем безопасности, действующие для операции
}

/** Все операции спецификации в виде карты «METHOD /path» → Operation. */
export function operations(doc: Json): Map<string, Operation> {
  const out = new Map<string, Operation>();
  const rootSecurity = securityNames(doc.security);
  for (const [path, item0] of Object.entries<Json>(doc.paths)) {
    const item = deref(doc, item0);
    if (!item || typeof item !== 'object') continue;
    for (const m of METHODS) {
      if (!item[m]) continue;
      const raw = deref(doc, item[m]);
      const params = new Map<string, Json>();
      // параметры уровня пути действуют на все операции, параметры операции их переопределяют
      for (const p0 of [...(item.parameters ?? []), ...(raw.parameters ?? [])]) {
        const p = deref(doc, p0);
        if (p?.name && p?.in) params.set(`${p.in}:${p.name}`, p);
      }
      const key = `${m.toUpperCase()} ${path}`;
      out.set(key, {
        key,
        path,
        method: m.toUpperCase(),
        raw,
        deprecated: raw.deprecated === true,
        parameters: params,
        security: raw.security !== undefined ? securityNames(raw.security) : rootSecurity,
      });
    }
  }
  return out;
}

function securityNames(sec: Json): string[] {
  if (!Array.isArray(sec)) return [];
  const names = new Set<string>();
  for (const req of sec) for (const n of Object.keys(req ?? {})) names.add(n);
  return [...names].sort();
}
