import { analyze, SpecError, toMarkdown, type Analysis, type Change, type Status } from '../src/index.ts';
import exampleConsumers from '../fixtures/shop/consumers.yaml';
import exampleOld from '../fixtures/shop/v1.yaml';
import exampleNew from '../fixtures/shop/v2.yaml';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const oldEl = $<HTMLTextAreaElement>('old');
const newEl = $<HTMLTextAreaElement>('new');
const mapEl = $<HTMLTextAreaElement>('map');
const errEl = $('error');
const resEl = $('result');

type Child = Node | string | null | undefined | false;
/** Собирает DOM без innerHTML: введённый пользователем текст всегда попадает как текст. */
function h(tag: string, props: Record<string, string> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
}

const STATUS: Record<Status, { cls: string; label: string }> = {
  broken: { cls: 's-broken', label: '❌ Сломается' },
  warn: { cls: 's-warn', label: '⚠️ Может сломаться' },
  unknown: { cls: 's-unknown', label: '❔ Неизвестно: не указаны используемые поля' },
  safe: { cls: 's-safe', label: '✅ Не затронут' },
};
const LEVEL: Record<string, string> = { error: 'Ломает', warn: 'Возможно', info: 'Безопасно' };

let last: Analysis | null = null;
let levelFilter = new Set(['error', 'warn']);

function copy(text: string, btn: HTMLElement): void {
  navigator.clipboard?.writeText(text).then(
    () => {
      const old = btn.textContent;
      btn.textContent = 'Скопировано';
      setTimeout(() => (btn.textContent = old), 1500);
    },
    () => undefined,
  );
}

function renderConsumers(a: Analysis): HTMLElement {
  const cards = h('div', { class: 'cards' });
  for (const ci of a.impact.consumers) {
    const st = STATUS[ci.status];
    const card = h('article', { class: 'card' }, h('h3', {}, ci.consumer.name, ci.consumer.owner ? h('span', { class: 'owner' }, ` ${ci.consumer.owner}`) : null), h('span', { class: `badge ${st.cls}` }, st.label));
    const seen = new Set<string>();
    const list = h('ul', { class: 'hits' });
    for (const hit of ci.hits) {
      const key = `${hit.change.operation}|${hit.change.id}|${hit.change.path ?? ''}|${hit.change.status ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.append(h('li', {}, h('code', {}, hit.change.operation), ': ', hit.change.text, hit.match === 'unspecified' ? ' (потребитель не указал, использует ли это)' : ''));
    }
    if (ci.hits.length) card.append(list);
    for (const cmd of ci.checks) {
      const btn = h('button', { type: 'button', 'aria-label': `Скопировать команду ${cmd}` }, 'Копировать');
      btn.addEventListener('click', () => copy(cmd, btn));
      card.append(h('div', { class: 'cmd' }, 'Проверить: ', h('code', {}, cmd), btn));
    }
    cards.append(card);
  }
  return cards;
}

function changesTable(changes: Change[]): HTMLElement {
  const shown = changes.filter((c) => levelFilter.has(c.level));
  const body = h('tbody');
  for (const c of shown) {
    body.append(h('tr', {}, h('td', { class: `lv lv-${c.level}` }, LEVEL[c.level]), h('td', {}, h('code', {}, c.operation)), h('td', {}, c.text), h('td', {}, h('code', {}, c.id))));
  }
  if (!shown.length) body.append(h('tr', {}, h('td', { colspan: '4' }, 'Нет изменений выбранных уровней')));
  return h('div', { class: 'scroll', tabindex: '0', role: 'region', 'aria-label': 'Таблица изменений контракта' }, h('table', {}, h('caption', { class: 'hint' }, `Показано ${shown.length} из ${changes.length}`), h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Уровень'), h('th', { scope: 'col' }, 'Операция'), h('th', { scope: 'col' }, 'Что изменилось'), h('th', { scope: 'col' }, 'Правило'))), body));
}

function render(): void {
  resEl.replaceChildren();
  errEl.hidden = true;
  if (!oldEl.value.trim() || !newEl.value.trim() || !mapEl.value.trim()) {
    last = null;
    resEl.append(h('p', { class: 'hint' }, 'Заполните все три поля или нажмите «Загрузить пример».'));
    return;
  }
  let a: Analysis;
  try {
    a = analyze(oldEl.value, newEl.value, mapEl.value);
  } catch (e) {
    last = null;
    errEl.hidden = false;
    errEl.textContent = e instanceof SpecError ? e.message : `Ошибка разбора: ${(e as Error).message}`;
    return;
  }
  last = a;
  const counts = a.impact.consumers.reduce<Record<Status, number>>((m, c) => ({ ...m, [c.status]: m[c.status] + 1 }), { broken: 0, warn: 0, unknown: 0, safe: 0 });
  const tile = (n: number, label: string, cls: string): HTMLElement => h('div', { class: `tile ${cls}` }, h('b', {}, String(n)), label);

  resEl.append(
    h('div', { class: 'tiles' }, tile(counts.broken, 'потребителей сломается', 's-broken'), tile(counts.warn, 'может сломаться', 's-warn'), tile(counts.unknown, 'неизвестно', 's-unknown'), tile(counts.safe, 'не затронуто', 's-safe')),
  );
  const actions = h('div', { class: 'bar' });
  const mdBtn = h('button', { type: 'button' }, 'Скопировать отчёт (Markdown)');
  mdBtn.addEventListener('click', () => copy(toMarkdown(a), mdBtn));
  const dl = h('button', { type: 'button' }, 'Скачать .md');
  dl.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([toMarkdown(a)], { type: 'text/markdown' }));
    const link = h('a', { href: url, download: 'contract-impact.md' });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
  actions.append(mdBtn, dl);
  resEl.append(actions, h('h2', { class: 'sec' }, 'Потребители'), renderConsumers(a));

  if (a.impact.unmapped.length) {
    resEl.append(
      h('h2', { class: 'sec' }, 'Не сопоставлено ни с одним потребителем'),
      h('p', { class: 'hint' }, 'Эти изменения касаются операций, которых нет в карте. Кто их использует, неизвестно: проверьте вручную.'),
      h('ul', { class: 'hits' }, ...a.impact.unmapped.map((c) => h('li', {}, h('code', {}, c.operation), `: ${c.text}`))),
    );
  }
  if (a.impact.stale.length) {
    resEl.append(
      h('h2', { class: 'sec' }, 'Устаревшие записи карты'),
      h('p', { class: 'hint' }, 'Этих операций нет ни в старой, ни в новой схеме: опечатка или карта давно не обновлялась.'),
      h('ul', { class: 'hits' }, ...a.impact.stale.map((s) => h('li', {}, `${s.consumer}: `, h('code', {}, s.operation)))),
    );
  }

  resEl.append(h('h2', { class: 'sec' }, `Все изменения контракта (${a.changes.length})`));
  const filters = h('div', { class: 'bar', role: 'group', 'aria-label': 'Фильтр по уровню' });
  const holder = h('div', {});
  for (const lvl of ['error', 'warn', 'info']) {
    const cb = h('input', { type: 'checkbox', id: `f-${lvl}` }) as HTMLInputElement;
    cb.checked = levelFilter.has(lvl);
    cb.addEventListener('change', () => {
      if (cb.checked) levelFilter.add(lvl);
      else levelFilter.delete(lvl);
      holder.replaceChildren(changesTable(a.changes));
    });
    filters.append(h('label', { class: 'f', for: `f-${lvl}` }, cb, ` ${LEVEL[lvl]} (${a.counts[lvl as 'error' | 'warn' | 'info']})`));
  }
  holder.append(changesTable(a.changes));
  resEl.append(filters, holder);
}

let timer: number | undefined;
const schedule = (): void => {
  clearTimeout(timer);
  timer = window.setTimeout(render, 200);
};
for (const el of [oldEl, newEl, mapEl]) el.addEventListener('input', schedule);

for (const [fileId, target] of [['old-file', oldEl], ['new-file', newEl], ['map-file', mapEl]] as const) {
  $<HTMLInputElement>(fileId).addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    target.value = await f.text();
    render();
  });
}

$('example').addEventListener('click', () => {
  oldEl.value = exampleOld;
  newEl.value = exampleNew;
  mapEl.value = exampleConsumers;
  levelFilter = new Set(['error', 'warn']);
  render();
});
$('clear').addEventListener('click', () => {
  oldEl.value = newEl.value = mapEl.value = '';
  render();
});

void last;
render();
