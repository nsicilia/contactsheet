import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, compress, pageBudget } from '../packages/core/dist/index.js';
import { SqliteArchive } from '../packages/storage/dist/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'archive.sqlite');
  const archive = new SqliteArchive(path);
  t.after(() => archive.close());
  return { path, engine: new ContextEngine(archive) };
}

test('compression is deterministic, bounded, ordered and keeps short input verbatim', () => {
  assert.equal(compress(['a\r\n', 'b']), 'a\r\nb');
  const lines = Array.from({ length: 700 }, (_, i) => i % 120 === 10 ? 'ERROR failure-' + i + '\n' : 'running job\n');
  lines.push('695 tests passed\n');
  const preview = compress(lines);
  for (const i of [10, 130, 250, 370, 490]) assert.ok(preview.includes(`${i+1} | ERROR failure-${i}`));
  assert.ok(preview.endsWith('701 | 695 tests passed'));
  assert.equal(preview, compress(lines));
  assert.ok(compress(lines, 80).length <= 80);
  assert.ok(compress(['🐈'.repeat(8000)]).isWellFormed());
});

test('stable receipts survive reopen; provenance can share the same indexed bytes', t => {
  const { path, engine } = fixture(t);
  const text = '\uFEFFstatus: start\r\n\r\nERROR deadline on worker 4\rfinished\0ok';
  const receipt = engine.index(text, 'test.log', 'suite');
  assert.deepEqual(engine.index(text, 'test.log', 'suite'), receipt);
  const reopened = new SqliteArchive(path);
  t.after(() => reopened.close());
  const other = new ContextEngine(reopened);
  assert.deepEqual(other.read(receipt.id), { text, next: null });
  const second = other.index(text, 'build.log');
  assert.notEqual(second.id, receipt.id);
  assert.equal(second.hash, receipt.hash);
  const hits = other.search('deadline "worker"', 5, second.id);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].line, hits[0].id], [3, second.id]);
  assert.equal(other.search('deadline').length, 2);
  assert.deepEqual(other.search('deadline OR absent'), []);
  assert.equal(other.read(second.id, 3, 1).text, 'ERROR deadline on worker 4\r');
  const db = new DatabaseSync(path);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM lines').get().n, 4); }
  finally { db.close(); }
});

test('bounded pages reconstruct Unicode, CRLF, empty lines, NUL and trailing separators', t => {
  const { engine } = fixture(t);
  for (const text of ['', '\r\n', '\n\n', '🧪\0', 'abc\rXYZ\n\r\n',
    'a'.repeat(pageBudget - 1) + '🐈'.repeat(pageBudget) + '\r\nnext\n']) {
    const { id } = engine.index(text);
    let cursor = { line: 1, offset: 0 };
    let recovered = '';
    do {
      const page = engine.read(id, cursor.line, 1, cursor.offset);
      assert.ok(page.text.length <= pageBudget && page.text.isWellFormed());
      if (page.next) assert.ok(page.text.length > 0);
      recovered += page.text;
      cursor = page.next;
    } while (cursor);
    assert.equal(recovered, text);
  }
});

test('invalid input, ranges and unsupported stores fail clearly', t => {
  const { path, engine } = fixture(t);
  const { id } = engine.index('🐈');
  assert.throws(() => engine.index('\uD800'), /Unicode/);
  assert.throws(() => engine.index('x'.repeat(8 * 1024 * 1024 + 1)), /8 MiB/);
  assert.throws(() => engine.index('\n'.repeat(100001)), /100000/);
  assert.throws(() => engine.search('***'), /search term/);
  assert.throws(() => engine.search('foo', 0), /limit/);
  assert.throws(() => engine.read('unknown'), /Unknown/);
  assert.throws(() => engine.read(id, 2), /outside/);
  assert.throws(() => engine.read(id, 1, 1, 1), /offset/);
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA user_version=99'); } finally { db.close(); }
  assert.throws(() => new SqliteArchive(path), /schema version/);
});

test('failed index transaction leaves neither partial lines nor searchable terms', t => {
  const { path, engine } = fixture(t);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT,'simulated interruption'); END");
  assert.throws(() => engine.index('rare sentinel\n'), /simulated interruption/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lines').get().n, 0);
  assert.deepEqual(engine.search('sentinel'), []);
  db.exec('DROP TRIGGER fail');
  engine.index('rare sentinel\n');
  assert.equal(engine.search('sentinel').length, 1);
});
