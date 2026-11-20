import { parse } from 'yaml';
import type { Change } from './diff.ts';
import { SpecError, type Json } from './spec.ts';

/** Что потребитель использует в одной операции. Не указанный список означает «не знаем» (статус unknown). */
export interface Use {
  operation: string; // «GET /users/{id}»
  response?: string[]; // читаемые поля ответа
  request?: string[]; // отправляемые поля тела
  parameters?: string[]; // используемые параметры (имя без «in:»)
  check?: string; // команда проверки, которую стоит запустить
}

export interface Consumer {
  name: string;
  owner?: string;
  uses: Use[];
}

export type Status = 'broken' | 'warn' | 'unknown' | 'safe';

export interface Hit {
  change: Change;
  use: Use;
  /** exact — совпало поле/параметр; operation — изменение касается операции целиком; unspecified — потребитель не указал, что использует. */
  match: 'exact' | 'operation' | 'unspecified';
}

export interface ConsumerImpact {
  consumer: Consumer;
  status: Status;
  hits: Hit[];
  checks: string[];
}

export interface ImpactReport {
  consumers: ConsumerImpact[];
  /** Изменения error/warn в операциях, которых нет ни в одной карте: чьи они — неизвестно. */
  unmapped: Change[];
  /** Записи карты, которых нет ни в старой, ни в новой схеме (опечатка или устаревшая карта). */
  stale: { consumer: string; operation: string }[];
}

const normMethod = (op: string): string => {
  const m = /^\s*([A-Za-z]+)\s+(\S.*?)\s*$/.exec(op);
  return m ? `${m[1]!.toUpperCase()} ${m[2]}` : op.trim();
};

function strList(v: Json, where: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new SpecError(`${where}: ожидается список строк`);
  return v;
}

/** Разбирает YAML-карту потребителей: `consumers:` — список или словарь «имя → описание». */
export function parseConsumers(text: string): Consumer[] {
  let doc: Json;
  try {
    doc = parse(text);
  } catch (e) {
    throw new SpecError(`карта потребителей: не удалось разобрать YAML — ${(e as Error).message.split('\n')[0]}`);
  }
  const raw = doc?.consumers;
  if (!raw || typeof raw !== 'object') throw new SpecError('карта потребителей: нет раздела consumers');
  const entries: [string, Json][] = Array.isArray(raw) ? raw.map((c: Json) => [String(c?.name ?? ''), c]) : Object.entries(raw);
  const out: Consumer[] = [];
  for (const [name, c] of entries) {
    if (!name) throw new SpecError('карта потребителей: у потребителя нет имени');
    if (out.some((x) => x.name === name)) throw new SpecError(`карта потребителей: имя «${name}» повторяется`);
    if (!Array.isArray(c?.uses)) throw new SpecError(`карта потребителей: у «${name}» нет списка uses`);
    const uses: Use[] = c.uses.map((u: Json, i: number) => {
      if (typeof u?.operation !== 'string') throw new SpecError(`карта потребителей: «${name}», запись ${i + 1}: нет поля operation`);
      const where = `«${name}», ${u.operation}`;
      return {
        operation: normMethod(u.operation),
        response: strList(u.response, `${where}, response`),
        request: strList(u.request, `${where}, request`),
        parameters: strList(u.parameters, `${where}, parameters`),
        check: typeof u.check === 'string' ? u.check : undefined,
      };
    });
    out.push({ name, owner: typeof c.owner === 'string' ? c.owner : undefined, uses });
  }
  return out;
}

const normPath = (p: string): string => p.replace(/\[\]/g, '').replace(/^\./, '');

/** Пересекаются ли два пути свойств: совпадают или один содержит другой («address» и «address.city»). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  if (x === '*' || y === '*') return true;
  return x === y || x.startsWith(y + '.') || y.startsWith(x + '.');
}

// Эти изменения касаются любого, кто вызывает операцию: новое обязательное требование надо выполнить всем.
const OPERATION_WIDE = new Set([
  'new-required-request-property',
  'new-required-request-parameter',
  'request-property-became-required',
  'request-parameter-became-required',
  'request-body-became-required',
]);

function matchUse(change: Change, use: Use): Hit['match'] | null {
  if (OPERATION_WIDE.has(change.id)) return 'operation';
  switch (change.scope) {
    case 'operation':
    case 'security':
      return 'operation';
    case 'response':
      if (change.path === undefined) return 'operation'; // убран статус ответа и т.п.
      if (!use.response) return 'unspecified';
      return use.response.some((f) => pathsOverlap(f, change.path!)) ? 'exact' : null;
    case 'request':
      if (change.path === undefined) return 'operation';
      if (!use.request) return 'unspecified';
      return use.request.some((f) => pathsOverlap(f, change.path!)) ? 'exact' : null;
    case 'parameter': {
      if (!use.parameters) return 'unspecified';
      const name = (change.path ?? '').split(':').slice(1).join(':').toLowerCase();
      return use.parameters.some((p) => p.toLowerCase() === name) ? 'exact' : null;
    }
  }
}

/**
 * Переводит изменения контракта в влияние на потребителей. Учитываются только error и warn.
 * Потребитель, который не перечислил поля используемой операции, получает статус unknown, а не safe.
 */
export function assessImpact(changes: Change[], consumers: Consumer[], knownOps: Set<string>): ImpactReport {
  const relevant = changes.filter((c) => c.level !== 'info');
  const consumed = new Set<string>();
  const impacts: ConsumerImpact[] = consumers.map((consumer) => {
    const hits: Hit[] = [];
    for (const use of consumer.uses) {
      consumed.add(use.operation);
      for (const change of relevant) {
        if (change.operation !== use.operation) continue;
        const match = matchUse(change, use);
        if (match) hits.push({ change, use, match });
      }
    }
    let status: Status = 'safe';
    if (hits.some((h) => h.match !== 'unspecified' && h.change.level === 'error')) status = 'broken';
    else if (hits.some((h) => h.match !== 'unspecified')) status = 'warn';
    else if (hits.length) status = 'unknown';
    const checks = [...new Set(hits.map((h) => h.use.check).filter((c): c is string => !!c))];
    return { consumer, status, hits, checks };
  });

  const unmapped = relevant.filter((c) => !consumed.has(c.operation));
  const stale: ImpactReport['stale'] = [];
  for (const c of consumers) for (const u of c.uses) if (!knownOps.has(u.operation)) stale.push({ consumer: c.name, operation: u.operation });

  const order: Record<Status, number> = { broken: 0, warn: 1, unknown: 2, safe: 3 };
  impacts.sort((a, b) => order[a.status] - order[b.status] || a.consumer.name.localeCompare(b.consumer.name));
  return { consumers: impacts, unmapped, stale };
}
