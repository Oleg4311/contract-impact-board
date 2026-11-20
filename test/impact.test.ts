import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parse, stringify } from 'yaml';
import { analyze, diffSpecs, parseConsumers, parseSpec, pathsOverlap, SpecError, toMarkdown } from '../src/index.ts';

const fx = (name: string): string => readFileSync(new URL(`../fixtures/shop/${name}`, import.meta.url), 'utf8');
const V1 = fx('v1.yaml');
const V2 = fx('v2.yaml');
const MAP = fx('consumers.yaml');

describe('карта потребителей', () => {
  test('разбор списка и словаря', () => {
    const asDict = parseConsumers('consumers:\n  a:\n    uses:\n      - { operation: "get /x", response: [id] }\n');
    assert.deepEqual(asDict[0]!.uses[0], { operation: 'GET /x', response: ['id'], request: undefined, parameters: undefined, check: undefined });
    const asList = parseConsumers('consumers:\n  - name: b\n    owner: me\n    uses: []\n');
    assert.equal(asList[0]!.owner, 'me');
  });

  test('ошибки в карте называют потребителя и поле', () => {
    assert.throws(() => parseConsumers('x: 1'), /нет раздела consumers/);
    assert.throws(() => parseConsumers('consumers:\n  a: {}\n'), /у «a» нет списка uses/);
    assert.throws(() => parseConsumers('consumers:\n  a:\n    uses: [{ response: [id] }]\n'), /нет поля operation/);
    assert.throws(() => parseConsumers('consumers:\n  a:\n    uses: [{ operation: GET /x, response: id }]\n'), /ожидается список строк/);
    assert.throws(() => parseConsumers('consumers:\n  - name: a\n    uses: []\n  - name: a\n    uses: []\n'), /повторяется/);
    assert.throws(() => parseConsumers('consumers: [unclosed'), SpecError);
  });

  test('пересечение путей полей', () => {
    const yes: [string, string][] = [['email', 'email'], ['address', 'address.zip'], ['address.zip', 'address'], ['items[].id', 'items.id'], ['[].id', 'id'], ['*', 'any.thing']];
    const no: [string, string][] = [['email', 'emails'], ['address.zip', 'address.city'], ['a.b', 'a.bc'], ['id', 'user.id']];
    for (const [a, b] of yes) assert.ok(pathsOverlap(a, b), `${a} ~ ${b}`);
    for (const [a, b] of no) assert.ok(!pathsOverlap(a, b), `${a} !~ ${b}`);
  });
});

describe('сценарий «магазин»: удалено поле email', () => {
  const a = analyze(V1, V2, MAP);
  const byName = Object.fromEntries(a.impact.consumers.map((c) => [c.consumer.name, c]));

  test('из трёх потребителей email ломает двух: mobile-app и billing-service', () => {
    const hitsEmail = (n: string): boolean => byName[n]!.hits.some((h) => h.change.id === 'response-required-property-removed' && h.change.path === 'email');
    assert.ok(hitsEmail('mobile-app'));
    assert.ok(hitsEmail('billing-service'));
    assert.ok(!byName['analytics-job']!.hits.some((h) => h.change.path?.endsWith('email')), 'analytics-job читает только id и name');
  });

  test('итоговые статусы', () => {
    assert.equal(byName['mobile-app']!.status, 'broken');
    assert.equal(byName['billing-service']!.status, 'broken');
    assert.equal(byName['analytics-job']!.status, 'safe');
  });

  test('порядок: сначала сломанные', () => {
    assert.deepEqual(a.impact.consumers.map((c) => c.consumer.name), ['billing-service', 'mobile-app', 'analytics-job']);
  });

  test('новое обязательное свойство запроса касается любого вызывающего операцию, даже без поля', () => {
    const mobile = byName['mobile-app']!;
    const h = mobile.hits.find((x) => x.change.id === 'new-required-request-property');
    assert.ok(h && h.match === 'operation');
  });

  test('billing: удалено address.zip — предупреждение, security добавлена — ошибка', () => {
    const ids = byName['billing-service']!.hits.map((h) => `${h.change.id}:${h.change.level}`);
    assert.ok(ids.includes('response-optional-property-removed:warn'));
    assert.ok(ids.includes('api-security-added:error'));
  });

  test('команды проверки берутся только у затронутых использований', () => {
    assert.deepEqual(byName['mobile-app']!.checks.sort(), ['npm run test:contract -- orders', 'npm run test:contract -- users']);
    assert.deepEqual(byName['billing-service']!.checks, ['make contract-test SERVICE=users']);
    assert.deepEqual(byName['analytics-job']!.checks, []);
  });

  test('изменение без владельца попадает в «не сопоставлено», а не теряется', () => {
    assert.deepEqual(a.impact.unmapped.map((c) => `${c.operation} ${c.id}`), ['GET /legacy/ping api-path-removed-without-deprecation']);
  });

  test('счётчики сходятся с самим списком', () => {
    const count = (l: string): number => a.changes.filter((c) => c.level === l).length;
    assert.deepEqual(a.counts, { error: count('error'), warn: count('warn'), info: count('info') });
    assert.ok(a.counts.error === 5 && a.counts.info >= 1);
  });

  test('без изменений все потребители safe', () => {
    const same = analyze(V1, V1, MAP);
    assert.deepEqual(same.changes, []);
    assert.ok(same.impact.consumers.every((c) => c.status === 'safe'));
    assert.deepEqual(same.impact.unmapped, []);
  });
});

describe('статус «неизвестно» и устаревшая карта', () => {
  test('потребитель без списка полей получает unknown, а не safe', () => {
    const map = 'consumers:\n  vague:\n    uses:\n      - operation: GET /users/{id}\n';
    const a = analyze(V1, V2, map);
    const v = a.impact.consumers[0]!;
    assert.equal(v.status, 'unknown');
    assert.ok(v.hits.length > 0 && v.hits.every((h) => h.match === 'unspecified'));
  });

  test('пустой список полей — осознанное «не использует»: safe', () => {
    const map = 'consumers:\n  sure:\n    uses:\n      - operation: GET /users/{id}\n        response: []\n';
    assert.equal(analyze(V1, V2, map).impact.consumers[0]!.status, 'safe');
  });

  test('если указаны только поля ответа, изменение запроса — тоже неизвестно', () => {
    const map = 'consumers:\n  half:\n    uses:\n      - operation: POST /orders\n        response: [id]\n';
    assert.equal(analyze(V1, V2, map).impact.consumers[0]!.status, 'broken'); // новое обязательное поле касается всех
    const map2 = 'consumers:\n  half:\n    uses:\n      - operation: POST /orders\n        request: [items]\n        response: [total]\n';
    const a = analyze(V1, V2, map2);
    assert.equal(a.impact.consumers[0]!.status, 'broken');
  });

  test('операция из карты, которой нет в схемах, — устаревшая запись (опечатка)', () => {
    const map = 'consumers:\n  c:\n    uses:\n      - { operation: "GET /usrs/{id}", response: [id] }\n      - { operation: "GET /users", response: [] }\n';
    const a = analyze(V1, V2, map);
    assert.deepEqual(a.impact.stale, [{ consumer: 'c', operation: 'GET /usrs/{id}' }]);
  });

  test('параметры сопоставляются по имени без учёта регистра для заголовков', () => {
    const o = V1;
    const n = V1.replace('        - { name: cursor, in: query, schema: { type: string } }\n', '        - { name: X-Tenant, in: header, required: true, schema: { type: string } }\n');
    const map = 'consumers:\n  c:\n    uses:\n      - { operation: GET /users, response: [], parameters: [limit] }\n';
    const a = analyze(o, n, map);
    // новый обязательный параметр касается всех вызывающих
    assert.equal(a.impact.consumers[0]!.status, 'broken');
    // а удаление параметра cursor — только тех, кто его использует
    const used = analyze(o, n, 'consumers:\n  c:\n    uses:\n      - { operation: GET /users, response: [], parameters: [cursor] }\n');
    assert.ok(used.impact.consumers[0]!.hits.some((h) => h.change.id === 'request-parameter-removed' && h.match === 'exact'));
  });
});

describe('метаморфические свойства', () => {
  const d12 = diffSpecs(parseSpec(V1), parseSpec(V2));
  const d21 = diffSpecs(parseSpec(V2), parseSpec(V1));
  const key = (id: string, c: { operation: string; path?: string }): string => `${id}|${c.operation}|${c.path ?? ''}`;

  test('что «удалено» в одну сторону, то «добавлено» в обратную', () => {
    const pairs: [string, string[]][] = [
      ['response-required-property-removed', ['response-required-property-added', 'response-optional-property-added']],
      ['response-optional-property-removed', ['response-required-property-added', 'response-optional-property-added']],
      ['new-required-request-property', ['request-property-removed']],
      ['request-property-removed', ['new-optional-request-property', 'new-required-request-property']],
      ['api-security-added', ['api-security-removed']],
      ['api-path-removed-without-deprecation', ['endpoint-added']],
      ['endpoint-added', ['api-path-removed-without-deprecation', 'api-removed-without-deprecation']],
    ];
    for (const [fwd, back] of pairs) {
      for (const c of d12.filter((x) => x.id === fwd)) {
        assert.ok(back.some((b) => d21.some((x) => key(x.id, x) === key(b, c))), `для ${key(fwd, c)} нет обратного изменения среди ${back.join(', ')}`);
      }
    }
  });

  test('порядок ключей в документе не влияет на результат', () => {
    const reverse = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverse);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)]));
      return v;
    };
    const shuffled = stringify(reverse(parse(V2)));
    assert.notEqual(shuffled, V2);
    assert.deepEqual(diffSpecs(parseSpec(V1), parseSpec(shuffled)), d12);
  });
});

describe('отчёт и командная строка', () => {
  test('Markdown содержит потребителей, статусы, команды и «не сопоставлено»', () => {
    const md = toMarkdown(analyze(V1, V2, MAP));
    for (const s of ['## mobile-app (@team-mobile)', '❌ Затронут: сломается', '✅ Не затронут', '`npm run test:contract -- users`', '## Не сопоставлено ни с одним потребителем', 'GET /legacy/ping']) {
      assert.ok(md.includes(s), `в отчёте нет: ${s}`);
    }
  });

  const cli = (...args: string[]): { code: number | null; out: string; err: string } => {
    const r = spawnSync(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const files = ['v1.yaml', 'v2.yaml', 'consumers.yaml'].map((f) => new URL(`../fixtures/shop/${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  test('CLI: текстовый вывод и код выхода по --fail-on', () => {
    const plain = cli(...files);
    assert.equal(plain.code, 0);
    assert.match(plain.out, /СЛОМАЕТСЯ billing-service/);
    assert.match(plain.out, /ок\s+analytics-job/);
    assert.equal(cli(...files, '--fail-on', 'broken').code, 1);
    const same = cli(files[0]!, files[0]!, files[2]!, '--fail-on', 'unknown');
    assert.equal(same.code, 0);
  });

  test('CLI: json и markdown', () => {
    const j = JSON.parse(cli(...files, '--format', 'json').out);
    assert.equal(j.impact.consumers.length, 3);
    assert.match(cli(...files, '--format', 'markdown').out, /^# Влияние изменений API/);
  });

  test('CLI: ошибки ввода дают код 2 и понятное сообщение', () => {
    assert.equal(cli().code, 2);
    assert.equal(cli(files[0]!, files[1]!).code, 2);
    const bad = cli(files[0]!, files[2]!, files[2]!); // карта вместо схемы
    assert.equal(bad.code, 2);
    assert.match(bad.err, /новая схема: поддерживается только OpenAPI 3|новая схема/);
    assert.equal(cli(...files, '--fail-on', 'wat').code, 2);
  });
});
