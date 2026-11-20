// Командная строка: contract-impact <старая.yaml> <новая.yaml> <карта.yaml> [--format text|markdown|json] [--fail-on broken|warn|unknown]
import { readFileSync } from 'node:fs';
import { analyze } from './analyze.ts';
import type { Status } from './consumers.ts';
import { toMarkdown } from './report.ts';
import { SpecError } from './spec.ts';

const USAGE = `contract-impact: какие потребители API заденет изменение контракта

Использование:
  contract-impact <старая-схема> <новая-схема> <карта-потребителей> [флаги]

Флаги:
  --format text|markdown|json   формат вывода (по умолчанию text)
  --fail-on broken|warn|unknown код выхода 1, если есть потребитель с таким статусом или хуже
                                (broken — только сломанные; warn — и потенциально; unknown — и неопределённые)
  -h, --help                    справка
`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help') || args.length === 0) {
  process.stdout.write(USAGE);
  process.exit(args.length === 0 ? 2 : 0);
}

const flags = new Map<string, string>();
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a.startsWith('--')) flags.set(a.slice(2), args[++i] ?? '');
  else files.push(a);
}
if (files.length !== 3) {
  process.stderr.write('нужно ровно три файла: старая схема, новая схема, карта потребителей\n\n' + USAGE);
  process.exit(2);
}
const format = flags.get('format') ?? 'text';
const failOn = flags.get('fail-on');
if (!['text', 'markdown', 'json'].includes(format) || (failOn && !['broken', 'warn', 'unknown'].includes(failOn))) {
  process.stderr.write('неверное значение флага\n\n' + USAGE);
  process.exit(2);
}

try {
  const [o, n, m] = files.map((f) => readFileSync(f, 'utf8')) as [string, string, string];
  const a = analyze(o, n, m);
  if (format === 'json') process.stdout.write(JSON.stringify(a, null, 2) + '\n');
  else if (format === 'markdown') process.stdout.write(toMarkdown(a) + '\n');
  else {
    const mark: Record<Status, string> = { broken: 'СЛОМАЕТСЯ', warn: 'ВОЗМОЖНО', unknown: 'НЕЯСНО  ', safe: 'ок       ' };
    process.stdout.write(`изменений: ${a.counts.error} ломающих, ${a.counts.warn} потенциально, ${a.counts.info} безопасных\n\n`);
    for (const ci of a.impact.consumers) {
      process.stdout.write(`${mark[ci.status]} ${ci.consumer.name}\n`);
      for (const h of new Set(ci.hits.map((x) => `    ${x.change.operation}: ${x.change.text} [${x.change.id}]`))) process.stdout.write(h + '\n');
      for (const c of ci.checks) process.stdout.write(`    проверить: ${c}\n`);
    }
    if (a.impact.unmapped.length) {
      process.stdout.write('\nне сопоставлено с потребителями:\n');
      for (const c of a.impact.unmapped) process.stdout.write(`    ${c.operation}: ${c.text} [${c.id}]\n`);
    }
    if (a.impact.stale.length) {
      process.stdout.write('\nустаревшие записи карты:\n');
      for (const s of a.impact.stale) process.stdout.write(`    ${s.consumer}: ${s.operation}\n`);
    }
  }
  const rank: Record<Status, number> = { broken: 0, warn: 1, unknown: 2, safe: 3 };
  if (failOn && a.impact.consumers.some((c) => rank[c.status] <= rank[failOn as Status])) process.exitCode = 1;
} catch (e) {
  if (e instanceof SpecError) {
    process.stderr.write(`ошибка: ${e.message}\n`);
    process.exit(2);
  }
  throw e;
}
