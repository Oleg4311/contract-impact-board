import { deref, type Json } from './spec.ts';

/** Свойство схемы в «плоском» виде: путь вида `data.items[].email`. */
export interface Prop {
  path: string;
  type: string; // «string», «integer:int64», «object», «array»...
  required: boolean;
  enum?: string[];
  nullable: boolean;
  deprecated: boolean;
}

const MAX_DEPTH = 12;

function typeOf(s: Json): string {
  let t: string = Array.isArray(s.type) ? s.type.filter((x: string) => x !== 'null').join('|') : (s.type ?? '');
  if (!t) t = s.properties || s.additionalProperties ? 'object' : s.items ? 'array' : s.enum ? 'enum' : '';
  return s.format ? `${t}:${s.format}` : t;
}

function isNullable(s: Json): boolean {
  return s.nullable === true || (Array.isArray(s.type) && s.type.includes('null'));
}

/** Объединяет allOf в одну схему (свойства и required складываются). */
function mergeAllOf(doc: Json, schema: Json, seen: Set<string>): Json {
  const s = deref(doc, schema, new Set(seen));
  if (!Array.isArray(s?.allOf)) return s ?? {};
  const merged: Json = { ...s, properties: { ...(s.properties ?? {}) }, required: [...(s.required ?? [])] };
  delete merged.allOf;
  for (const part of s.allOf) {
    const p = mergeAllOf(doc, part, seen);
    Object.assign(merged.properties, p.properties ?? {});
    merged.required.push(...(p.required ?? []));
    for (const k of ['type', 'items', 'enum', 'format', 'additionalProperties'] as const) if (merged[k] === undefined && p[k] !== undefined) merged[k] = p[k];
  }
  return merged;
}

/**
 * Разворачивает схему в плоскую карту свойств. oneOf/anyOf: свойства всех вариантов считаются необязательными
 * (мы не можем знать, какой вариант получит потребитель). Глубина и циклы ограничены.
 */
export function flatten(doc: Json, schema: Json): Map<string, Prop> {
  const out = new Map<string, Prop>();
  const walk = (node: Json, path: string, required: boolean, depth: number, refs: string[]): void => {
    if (!node || depth > MAX_DEPTH) return;
    if (typeof node.$ref === 'string') {
      if (refs.includes(node.$ref)) return; // рекурсивная схема
      refs = [...refs, node.$ref];
    }
    const s = mergeAllOf(doc, node, new Set());
    if (!s || typeof s !== 'object') return;
    const variants: Json[] = [...(s.oneOf ?? []), ...(s.anyOf ?? [])];
    if (path) {
      out.set(path, {
        path,
        type: typeOf(s),
        required,
        enum: Array.isArray(s.enum) ? s.enum.map(String).sort() : undefined,
        nullable: isNullable(s),
        deprecated: s.deprecated === true,
      });
    }
    const req = new Set<string>(s.required ?? []);
    for (const [name, child] of Object.entries<Json>(s.properties ?? {})) {
      walk(child, path ? `${path}.${name}` : name, req.has(name), depth + 1, refs);
    }
    if (s.items) walk(s.items, `${path}[]`, true, depth + 1, refs);
    for (const v of variants) {
      // свойства вариантов добавляем, но не делаем обязательными
      const sub = flatten(doc, v);
      for (const [p, prop] of sub) {
        const full = path ? `${path}.${p}` : p;
        if (!out.has(full)) out.set(full, { ...prop, path: full, required: false });
      }
    }
  };
  walk(schema, '', true, 0, []);
  return out;
}
