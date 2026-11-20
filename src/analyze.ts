import { assessImpact, parseConsumers, type ImpactReport } from './consumers.ts';
import { diffSpecs, type Change } from './diff.ts';
import { operations, parseSpec } from './spec.ts';

export interface Analysis {
  changes: Change[];
  impact: ImpactReport;
  counts: { error: number; warn: number; info: number };
}

/** Полный разбор: две схемы и карта потребителей (текст YAML/JSON) → изменения и влияние на потребителей. */
export function analyze(oldText: string, newText: string, mapText: string): Analysis {
  const oldDoc = parseSpec(oldText, 'старая схема');
  const newDoc = parseSpec(newText, 'новая схема');
  const consumers = parseConsumers(mapText);
  const changes = diffSpecs(oldDoc, newDoc);
  const known = new Set([...operations(oldDoc).keys(), ...operations(newDoc).keys()]);
  const impact = assessImpact(changes, consumers, known);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const c of changes) counts[c.level]++;
  return { changes, impact, counts };
}
