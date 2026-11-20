export { analyze, type Analysis } from './analyze.ts';
export { assessImpact, parseConsumers, pathsOverlap, type Consumer, type ConsumerImpact, type Hit, type ImpactReport, type Status, type Use } from './consumers.ts';
export { diffSpecs, type Change, type Level, type Scope } from './diff.ts';
export { toMarkdown } from './report.ts';
export { SpecError, operations, parseSpec } from './spec.ts';
