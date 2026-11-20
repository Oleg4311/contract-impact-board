import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { stringify } from 'yaml';
import { diffSpecs, parseSpec, SpecError, type Change } from '../src/index.ts';

type Json = Record<string, unknown>;

/** Собирает минимальную спецификацию вокруг одной операции GET /things. */
function spec(op: Json, components: Json = {}, extra: Json = {}): ReturnType<typeof parseSpec> {
  return parseSpec(stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: { '/things': { get: { responses: { '200': { description: 'ok' } }, ...op } } }, components, ...extra }));
}

const json = (schema: Json): Json => ({ content: { 'application/json': { schema } } });
const okWith = (schema: Json): Json => ({ responses: { '200': { description: 'ok', ...json(schema) } } });
const body = (schema: Json, required = true): Json => ({ requestBody: { required, ...json(schema) } });
const obj = (properties: Json, required: string[] = []): Json => ({ type: 'object', properties, required });

function ids(changes: Change[]): string[] {
  return changes.map((c) => `${c.id}${c.path ? ':' + c.path : ''}`).sort();
}

describe('правила сравнения', () => {
  test('одинаковые схемы не дают изменений', () => {
    const a = spec(okWith(obj({ id: { type: 'string' } }, ['id'])));
    assert.deepEqual(diffSpecs(a, a), []);
  });

  const cases: { name: string; old: Json; next: Json; expect: string[]; level?: Record<string, string> }[] = [
    {
      name: 'ответ: удалено обязательное свойство — ошибка, необязательное — предупреждение',
      old: okWith(obj({ id: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } }, ['id', 'a'])),
      next: okWith(obj({ id: { type: 'string' } }, ['id'])),
      expect: ['response-optional-property-removed:b', 'response-required-property-removed:a'],
      level: { 'response-required-property-removed': 'error', 'response-optional-property-removed': 'warn' },
    },
    {
      name: 'ответ: тип свойства изменён',
      old: okWith(obj({ n: { type: 'integer' } }, ['n'])),
      next: okWith(obj({ n: { type: 'string' } }, ['n'])),
      expect: ['response-property-type-changed:n'],
    },
    {
      name: 'ответ: формат — часть типа',
      old: okWith(obj({ n: { type: 'integer', format: 'int32' } }, ['n'])),
      next: okWith(obj({ n: { type: 'integer', format: 'int64' } }, ['n'])),
      expect: ['response-property-type-changed:n'],
    },
    {
      name: 'ответ: обязательное свойство стало необязательным',
      old: okWith(obj({ n: { type: 'string' } }, ['n'])),
      next: okWith(obj({ n: { type: 'string' } })),
      expect: ['response-property-became-optional:n'],
    },
    {
      name: 'ответ: значение enum добавлено — предупреждение, убрано — безопасно',
      old: okWith(obj({ s: { type: 'string', enum: ['a', 'b'] } }, ['s'])),
      next: okWith(obj({ s: { type: 'string', enum: ['b', 'c'] } }, ['s'])),
      expect: ['response-property-enum-value-added:s', 'response-property-enum-value-removed:s'],
      level: { 'response-property-enum-value-added': 'warn', 'response-property-enum-value-removed': 'info' },
    },
    {
      name: 'ответ: добавлены свойства — безопасно',
      old: okWith(obj({ id: { type: 'string' } }, ['id'])),
      next: okWith(obj({ id: { type: 'string' }, x: { type: 'string' }, y: { type: 'string' } }, ['id', 'x'])),
      expect: ['response-optional-property-added:y', 'response-required-property-added:x'],
      level: { 'response-optional-property-added': 'info', 'response-required-property-added': 'info' },
    },
    {
      name: 'запрос: новое обязательное свойство — ошибка, необязательное — безопасно',
      old: body(obj({ a: { type: 'string' } }, ['a'])),
      next: body(obj({ a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } }, ['a', 'b'])),
      expect: ['new-optional-request-property:c', 'new-required-request-property:b'],
      level: { 'new-required-request-property': 'error', 'new-optional-request-property': 'info' },
    },
    {
      name: 'запрос: свойство удалено — предупреждение',
      old: body(obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a'])),
      next: body(obj({ a: { type: 'string' } }, ['a'])),
      expect: ['request-property-removed:b'],
      level: { 'request-property-removed': 'warn' },
    },
    {
      name: 'запрос: свойство стало обязательным и тип изменился',
      old: body(obj({ a: { type: 'string' }, n: { type: 'integer' } })),
      next: body(obj({ a: { type: 'string' }, n: { type: 'string' } }, ['a'])),
      expect: ['request-property-became-required:a', 'request-property-type-changed:n'],
    },
    {
      name: 'запрос: значение enum убрано — ошибка, добавлено — тишина',
      old: body(obj({ s: { type: 'string', enum: ['a', 'b'] } }, ['s'])),
      next: body(obj({ s: { type: 'string', enum: ['b', 'c'] } }, ['s'])),
      expect: ['request-property-enum-value-removed:s'],
    },
    {
      name: 'тело запроса стало обязательным',
      old: body(obj({ a: { type: 'string' } }), false),
      next: body(obj({ a: { type: 'string' } }), true),
      expect: ['request-body-became-required'],
    },
    {
      name: 'параметры: добавлен обязательный / необязательный, удалён',
      old: { parameters: [{ name: 'gone', in: 'query', schema: { type: 'string' } }] },
      next: {
        parameters: [
          { name: 'must', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'may', in: 'query', schema: { type: 'string' } },
        ],
      },
      expect: ['new-optional-request-parameter:query:may', 'new-required-request-parameter:query:must', 'request-parameter-removed:query:gone'],
      level: { 'request-parameter-removed': 'warn', 'new-required-request-parameter': 'error' },
    },
    {
      name: 'параметры: стал обязательным, сменился тип и enum',
      old: { parameters: [{ name: 'p', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } }, { name: 'q', in: 'query', schema: { type: 'integer' } }] },
      next: { parameters: [{ name: 'p', in: 'query', required: true, schema: { type: 'string', enum: ['a'] } }, { name: 'q', in: 'query', schema: { type: 'string' } }] },
      expect: ['request-parameter-became-required:query:p', 'request-parameter-enum-value-removed:query:p', 'request-parameter-type-generalized:query:q'],
    },
    {
      name: 'параметры: сужение типа (string → integer) — ошибка',
      old: { parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] },
      next: { parameters: [{ name: 'q', in: 'query', schema: { type: 'integer' } }] },
      expect: ['request-parameter-type-changed:query:q'],
    },
    {
      name: 'ответы: убран успешный — ошибка, убран ошибочный — безопасно',
      old: { responses: { '200': { description: 'ok' }, '201': { description: 'ok' }, '404': { description: 'x' } } },
      next: { responses: { '200': { description: 'ok' } } },
      expect: ['response-non-success-status-removed', 'response-success-status-removed'],
      level: { 'response-success-status-removed': 'error', 'response-non-success-status-removed': 'info' },
    },
    {
      name: 'ответы: добавлены статусы — безопасно',
      old: { responses: { '200': { description: 'ok' } } },
      next: { responses: { '200': { description: 'ok' }, '202': { description: 'x' }, '409': { description: 'x' } } },
      expect: ['response-non-success-status-added', 'response-success-status-added'],
    },
    {
      name: 'ответ: убран тип содержимого',
      old: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } }, 'text/csv': { schema: { type: 'string' } } } } } },
      next: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } } },
      expect: ['response-media-type-removed'],
    },
    {
      name: 'безопасность: замена способа — убран способ (предупреждение), добавленный — безопасно',
      old: { security: [{ basic: [] }] },
      next: { security: [{ bearer: [] }] },
      expect: ['api-security-added:bearer', 'api-security-removed:basic'],
      level: { 'api-security-removed': 'warn', 'api-security-added': 'info' },
    },
    {
      name: 'безопасность: открытая операция стала защищённой — ошибка',
      old: {},
      next: { security: [{ bearer: [] }] },
      expect: ['api-security-anonymous-access-removed'],
      level: { 'api-security-anonymous-access-removed': 'error' },
    },
    {
      name: 'безопасность: защита снята — убранный способ безопасен',
      old: { security: [{ bearer: [] }] },
      next: { security: [] },
      expect: ['api-security-removed:bearer'],
      level: { 'api-security-removed': 'info' },
    },
    {
      name: 'безопасность: ещё одна альтернатива не ломает, а изменение набора схем «и» — ломает',
      old: { security: [{ a: [] }, { b: [] }] },
      next: { security: [{ a: [] }, { b: [] }, { c: [] }] },
      expect: ['api-security-added:c'],
    },
    {
      name: 'вложенные свойства и массивы: путь указывает точно',
      old: okWith(obj({ data: { type: 'array', items: obj({ user: obj({ email: { type: 'string' }, id: { type: 'string' } }, ['email', 'id']) }, ['user']) } }, ['data'])),
      next: okWith(obj({ data: { type: 'array', items: obj({ user: obj({ id: { type: 'string' } }, ['id']) }, ['user']) } }, ['data'])),
      expect: ['response-required-property-removed:data[].user.email'],
    },
    {
      name: 'удаление объекта целиком даёт одно изменение, а не по свойству',
      old: okWith(obj({ id: { type: 'string' }, addr: obj({ city: { type: 'string' }, zip: { type: 'string' } }, ['city']) }, ['id', 'addr'])),
      next: okWith(obj({ id: { type: 'string' } }, ['id'])),
      expect: ['response-required-property-removed:addr'],
    },
  ];

  // Для сверки с oasdiff в CI: EXPORT_CASES_DIR=каталог выгружает пары схем каждого случая
  const exportDir = process.env.EXPORT_CASES_DIR;
  if (exportDir) {
    cases.forEach((c, i) => {
      const dir = join(exportDir, String(i + 1).padStart(2, '0'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'old.yaml'), stringify(spec(c.old)));
      writeFileSync(join(dir, 'new.yaml'), stringify(spec(c.next)));
      writeFileSync(join(dir, 'name.txt'), c.name);
    });
  }

  for (const c of cases) {
    test(c.name, () => {
      const got = diffSpecs(spec(c.old), spec(c.next));
      assert.deepEqual(ids(got), [...c.expect].sort());
      for (const ch of got) {
        const want = c.level?.[ch.id];
        if (want) assert.equal(ch.level, want, `${ch.id}: уровень`);
        assert.equal(ch.operation, 'GET /things');
      }
    });
  }

  test('удалены операция и путь целиком; deprecated смягчает', () => {
    const mk = (paths: Json): ReturnType<typeof parseSpec> => parseSpec(stringify({ openapi: '3.0.3', info: {}, paths }));
    const old = mk({
      '/a': { get: { responses: {} }, post: { responses: {} } },
      '/b': { get: { responses: {} } },
      '/c': { get: { deprecated: true, responses: {} } },
    });
    const next = mk({ '/a': { get: { responses: {} } } });
    const got = diffSpecs(old, next);
    assert.deepEqual(
      got.map((c) => `${c.operation} ${c.id} ${c.level}`).sort(),
      ['GET /b api-path-removed-without-deprecation error', 'GET /c api-path-removed-with-deprecation info', 'POST /a api-removed-without-deprecation error'],
    );
  });

  test('операция добавлена', () => {
    const mk = (paths: Json): ReturnType<typeof parseSpec> => parseSpec(stringify({ openapi: '3.0.3', info: {}, paths }));
    const got = diffSpecs(mk({}), mk({ '/x': { get: { responses: {} } } }));
    assert.deepEqual(ids(got), ['endpoint-added']);
    assert.equal(got[0]!.level, 'info');
  });

  test('параметры уровня пути учитываются во всех операциях', () => {
    const mk = (params: Json[]): ReturnType<typeof parseSpec> =>
      parseSpec(stringify({ openapi: '3.0.3', info: {}, paths: { '/x': { parameters: params, get: { responses: {} }, post: { responses: {} } } } }));
    const got = diffSpecs(mk([]), mk([{ name: 'tenant', in: 'header', required: true, schema: { type: 'string' } }]));
    assert.deepEqual(
      got.map((c) => `${c.operation} ${c.id}`).sort(),
      ['GET /x new-required-request-parameter', 'POST /x new-required-request-parameter'],
    );
  });
});

describe('схемы: $ref, allOf, oneOf, циклы', () => {
  const withComponents = (schemas: Json, schema: Json): ReturnType<typeof parseSpec> => spec(okWith(schema), { schemas });

  test('$ref раскрывается, изменение внутри компонента видно во всех местах использования', () => {
    const user = (props: Json, req: string[]): Json => ({ User: obj(props, req) });
    const a = withComponents(user({ id: { type: 'string' }, mail: { type: 'string' } }, ['id', 'mail']), { $ref: '#/components/schemas/User' });
    const b = withComponents(user({ id: { type: 'string' } }, ['id']), { $ref: '#/components/schemas/User' });
    assert.deepEqual(ids(diffSpecs(a, b)), ['response-required-property-removed:mail']);
  });

  test('allOf складывает свойства и required', () => {
    const mk = (extra: Json): ReturnType<typeof parseSpec> =>
      withComponents({ Base: obj({ id: { type: 'string' } }, ['id']) }, { allOf: [{ $ref: '#/components/schemas/Base' }, obj(extra, Object.keys(extra))] });
    const got = diffSpecs(mk({ a: { type: 'string' } }), mk({}));
    assert.deepEqual(ids(got), ['response-required-property-removed:a']);
  });

  test('oneOf: свойства вариантов считаются необязательными', () => {
    const mk = (kind: Json): ReturnType<typeof parseSpec> => spec(okWith({ oneOf: [obj({ cat: { type: 'string' } }, ['cat']), obj(kind, Object.keys(kind))] }));
    const got = diffSpecs(mk({ dog: { type: 'string' } }), mk({}));
    assert.deepEqual(ids(got), ['response-optional-property-removed:dog']);
  });

  test('рекурсивная схема не зацикливает разбор', () => {
    const tree = { Node: obj({ value: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } }, ['value']) };
    const a = withComponents(tree, { $ref: '#/components/schemas/Node' });
    const b = withComponents({ Node: obj({ child: { $ref: '#/components/schemas/Node' } }) }, { $ref: '#/components/schemas/Node' });
    assert.deepEqual(ids(diffSpecs(a, b)), ['response-required-property-removed:value']);
  });

  test('свойства-массивы: тип элементов', () => {
    const mk = (t: string): ReturnType<typeof parseSpec> => spec(okWith(obj({ tags: { type: 'array', items: { type: t } } }, ['tags'])));
    assert.deepEqual(ids(diffSpecs(mk('string'), mk('integer'))), ['response-property-type-changed:tags[]']);
  });

  test('nullable через type-массив OpenAPI 3.1 не считается типом', () => {
    const mk = (type: unknown): ReturnType<typeof parseSpec> => parseSpec(stringify({ openapi: '3.1.0', info: {}, paths: { '/t': { get: { responses: { '200': { description: 'ok', ...json(obj({ n: { type } }, ['n'])) } } } } } }));
    assert.deepEqual(diffSpecs(mk('string'), mk(['string', 'null'])), []);
  });
});

describe('ошибки разбора', () => {
  test('не YAML, не OpenAPI 3, нет paths, битая ссылка', () => {
    assert.throws(() => parseSpec('a: [unclosed'), SpecError);
    assert.throws(() => parseSpec('swagger: "2.0"\npaths: {}'), /только OpenAPI 3/);
    assert.throws(() => parseSpec('openapi: 3.0.0\ninfo: {}'), /нет раздела paths/);
    assert.throws(() => parseSpec(''), SpecError);
    const bad = parseSpec(stringify({ openapi: '3.0.0', info: {}, paths: { '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } } } } } } } }));
    assert.throws(() => diffSpecs(bad, bad), /ссылка не найдена/);
  });

  test('внешние ссылки отвергаются с понятным сообщением', () => {
    const ext = parseSpec(stringify({ openapi: '3.0.0', info: {}, paths: { '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: 'other.yaml#/X' } } } } } } } } }));
    assert.throws(() => diffSpecs(ext, ext), /внешние ссылки не поддерживаются/);
  });

  test('JSON тоже принимается', () => {
    const doc = parseSpec(JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }));
    assert.equal(doc.openapi, '3.0.0');
  });
});
