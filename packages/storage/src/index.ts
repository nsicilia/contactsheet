import { DatabaseSync } from 'node:sqlite';
import { pageBudget, prefix, type Archive, type Cursor, type Entry, type Hit, type Page } from '@ctx/core';

const schema = `
  CREATE TABLE documents(hash TEXT PRIMARY KEY);
  CREATE TABLE entries(
    id TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES documents, source TEXT NOT NULL,
    session TEXT NOT NULL, createdAt TEXT NOT NULL, bytes INTEGER NOT NULL, lines INTEGER NOT NULL
  );
  CREATE INDEX entries_by_hash ON entries(hash);
  CREATE TABLE lines(
    rowid INTEGER PRIMARY KEY, hash TEXT NOT NULL REFERENCES documents,
    number INTEGER NOT NULL, raw BLOB NOT NULL, UNIQUE(hash, number)
  );
  CREATE VIEW searchable AS SELECT rowid, CAST(raw AS TEXT) AS body FROM lines;
  CREATE VIRTUAL TABLE terms USING fts5(body, content='searchable', content_rowid='rowid');
  PRAGMA application_id=1129601073;
  PRAGMA user_version=1;
`;

export class SqliteArchive implements Archive {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      const app = this.db.prepare('PRAGMA application_id').get()!.application_id;
      if (version === 0 && app === 0 && !this.db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()) {
        this.db.exec(schema);
      } else if (app !== 1129601073 || version !== 1) {
        throw new Error('Unrecognized archive or unsupported schema version');
      }
      this.db.exec('CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS session_usage(id TEXT PRIMARY KEY, tokens INTEGER, cost REAL, duration REAL)');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.close(); // Rolls back any open transaction.
      throw error;
    }
  }

  boardVisible(setting?: 'on' | 'off') {
    if (setting) this.db.prepare("INSERT INTO preferences VALUES ('board', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(setting);
    return this.db.prepare("SELECT value FROM preferences WHERE key='board'").get()?.value !== 'off';
  }

  recordSession(id: string, tokens: number | null, cost: number | null, duration: number | null) {
    this.db.prepare('INSERT OR REPLACE INTO session_usage(id,tokens,cost,duration) VALUES(?,?,?,?)').run(id,tokens,cost,duration);
  }

  boardTotals() {
    return this.db.prepare('SELECT count(*) AS sessions, sum(tokens) AS tokens, sum(cost) AS reportedCostUSD, sum(duration) AS reportedApiMs FROM session_usage').get();
  }

  codingLevel(level?: string) {
    if (level !== undefined) {
      this.db.prepare("INSERT INTO preferences VALUES ('coding', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(level);
      return level;
    }
    const saved = this.db.prepare("SELECT value FROM preferences WHERE key='coding'").get();
    return String(saved?.value ?? process.env.CONTACTSHEET_CODING_LEVEL ?? 'full');
  }

  close() { this.db.close(); }

  save(entry: Entry, lines: string[]): Entry {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.db.prepare('INSERT INTO documents VALUES (?) ON CONFLICT(hash) DO NOTHING').run(entry.hash);
      if (inserted.changes) {
        const add = this.db.prepare('INSERT INTO lines(hash, number, raw) VALUES (?, ?, ?)');
        const index = this.db.prepare('INSERT INTO terms(rowid, body) VALUES (?, ?)');
        for (const [i, line] of lines.entries()) {
          const { lastInsertRowid } = add.run(entry.hash, i + 1, Buffer.from(line));
          index.run(lastInsertRowid, line);
        }
      }
      this.db.prepare(`INSERT INTO entries(id, hash, source, session, createdAt, bytes, lines)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
        entry.id, entry.hash, entry.source, entry.session, entry.createdAt, entry.bytes, entry.lines,
      );
      const saved = this.db.prepare('SELECT * FROM entries WHERE id=?').get(entry.id) as unknown as Entry;
      this.db.exec('COMMIT');
      return saved;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  search(expression: string, limit: number, id?: string): Hit[] {
    return this.db.prepare(`
      SELECT e.id, e.source, l.number AS line,
        substr(snippet(terms, 0, '', '', '…', 16), 1, 240) AS excerpt
      FROM terms JOIN lines l ON l.rowid=terms.rowid JOIN entries e ON e.hash=l.hash
      WHERE terms MATCH ? AND (? IS NULL OR e.id=?)
      ORDER BY rank, e.id, l.number LIMIT ?
    `).all(expression, id ?? null, id ?? null, limit) as unknown as Hit[];
  }

  read(id: string, { line, offset }: Cursor, count: number): Page {
    const entry = this.db.prepare('SELECT hash, lines FROM entries WHERE id=?').get(id);
    if (!entry) throw new Error('Unknown archive ID');
    const total = Number(entry.lines);
    if (!total && line === 1 && offset === 0) return { text: '', next: null };
    if (line > total) throw new Error('Line outside archive');
    let text = '';
    const rows = this.db.prepare('SELECT raw FROM lines WHERE hash=? AND number>=? ORDER BY number LIMIT ?');
    for (const row of rows.iterate(String(entry.hash), line, count)) {
      const original = Buffer.from(row.raw as Uint8Array).toString('utf8');
      if (offset >= original.length || /[\uDC00-\uDFFF]/.test(original.charAt(offset))) {
        throw new Error('Invalid read offset');
      }
      const remaining = original.slice(offset);
      const part = prefix(remaining, pageBudget - text.length);
      text += part;
      if (part.length < remaining.length) return { text, next: { line, offset: offset + part.length } };
      line++;
      offset = 0;
      if (text.length === pageBudget) break;
    }
    return { text, next: line <= total ? { line, offset: 0 } : null };
  }
}
