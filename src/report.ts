import type { Analysis } from './analyze.ts';
import type { Status } from './consumers.ts';

const STATUS_TITLE: Record<Status, string> = {
  broken: '❌ Затронут: сломается',
  warn: '⚠️ Затронут: может сломаться',
  unknown: '❔ Неизвестно: потребитель не указал, какие поля использует',
  safe: '✅ Не затронут',
};

/** Отчёт в Markdown: удобно вставить в описание pull request или тикет. */
export function toMarkdown(a: Analysis): string {
  const L: string[] = [];
  const { error, warn, info } = a.counts;
  L.push('# Влияние изменений API на потребителей', '');
  L.push(`Изменений: **${error}** ломающих, **${warn}** потенциально ломающих, ${info} безопасных.`, '');

  for (const ci of a.impact.consumers) {
    const owner = ci.consumer.owner ? ` (${ci.consumer.owner})` : '';
    L.push(`## ${ci.consumer.name}${owner}`, '', STATUS_TITLE[ci.status], '');
    const seen = new Set<string>();
    for (const h of ci.hits) {
      const line = `- \`${h.change.operation}\`: ${h.change.text} _(${h.change.id}${h.match === 'unspecified' ? ', поля не указаны' : ''})_`;
      if (!seen.has(line)) {
        seen.add(line);
        L.push(line);
      }
    }
    if (ci.checks.length) L.push('', 'Проверить:', ...ci.checks.map((c) => `- \`${c}\``));
    L.push('');
  }

  if (a.impact.unmapped.length) {
    L.push('## Не сопоставлено ни с одним потребителем', '', 'Эти изменения затрагивают операции, которых нет в карте. Кто их использует, неизвестно — проверьте вручную.', '');
    for (const c of a.impact.unmapped) L.push(`- \`${c.operation}\`: ${c.text} _(${c.id})_`);
    L.push('');
  }
  if (a.impact.stale.length) {
    L.push('## Устаревшие записи карты', '', 'Этих операций нет ни в старой, ни в новой схеме (опечатка или карта давно не обновлялась).', '');
    for (const s of a.impact.stale) L.push(`- ${s.consumer}: \`${s.operation}\``);
    L.push('');
  }
  return L.join('\n');
}
