// Сверка нашего движка с oasdiff: на каждой паре схем сравниваются множества «операция + id правила» среди ошибок и предупреждений.
// Запуск: node scripts/crosscheck-oasdiff.mjs <путь-к-oasdiff> <каталог-с-парами>
// Каталог: подкаталоги с old.yaml и new.yaml (их выгружает EXPORT_CASES_DIR=... npm test) плюс fixtures/shop.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { diffSpecs, parseSpec } from '../src/index.ts';

const [bin, casesDir] = process.argv.slice(2);
if (!bin || !casesDir) {
  console.error('использование: crosscheck-oasdiff.mjs <oasdiff> <каталог-с-парами>');
  process.exit(2);
}

// Известные и осознанные расхождения: «id» → почему так. Пусто, пока сверка не покажет обратное.
const KNOWN = new Map(JSON.parse(readFileSync(new URL('./crosscheck-known.json', import.meta.url), 'utf8')));

const pairs = [{ name: 'fixtures/shop', dir: 'fixtures/shop', old: 'v1.yaml', next: 'v2.yaml' }];
for (const d of readdirSync(casesDir).sort()) {
  const dir = join(casesDir, d);
  if (existsSync(join(dir, 'old.yaml'))) pairs.push({ name: `${d} ${readFileSync(join(dir, 'name.txt'), 'utf8')}`, dir, old: 'old.yaml', next: 'new.yaml' });
}

function theirs(dir, oldF, newF) {
  const r = spawnSync(bin, ['breaking', join(dir, oldF), join(dir, newF), '--format', 'json'], { encoding: 'utf8' });
  if (r.status !== 0 && !r.stdout.trim()) throw new Error(`oasdiff: ${r.stderr}`);
  const list = r.stdout.trim() ? JSON.parse(r.stdout) : [];
  return list.map((x) => `${x.operation} ${x.path} ${x.id}`);
}

function ours(dir, oldF, newF) {
  const changes = diffSpecs(parseSpec(readFileSync(join(dir, oldF), 'utf8')), parseSpec(readFileSync(join(dir, newF), 'utf8')));
  return changes.filter((c) => c.level !== 'info').map((c) => {
    const [method, ...p] = c.operation.split(' ');
    return `${method} ${p.join(' ')} ${c.id}`;
  });
}

const count = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
let bad = 0;
let total = 0;
for (const p of pairs) {
  const a = count(ours(p.dir, p.old, p.next));
  const b = count(theirs(p.dir, p.old, p.next));
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const diffs = [];
  for (const k of keys) {
    total++;
    if (!a.has(k) || !b.has(k)) {
      const id = k.split(' ').pop();
      if (KNOWN.has(id)) continue;
      diffs.push(`${a.has(k) ? 'только у нас   ' : 'только у oasdiff'}: ${k}`);
    }
  }
  console.log(`${diffs.length ? '✗' : '✓'} ${p.name} (${keys.length} правил-операций)`);
  for (const d of diffs) console.log(`    ${d}`);
  bad += diffs.length;
}
console.log(`\nсверено пар: ${pairs.length}, расхождений: ${bad}`);
process.exit(bad ? 1 : 0);
