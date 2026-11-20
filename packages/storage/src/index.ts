import { DatabaseSync } from 'node:sqlite';
import { pageBudget, prefix, type Archive, type Cursor, type Decision, type DecisionDraft, type DecisionHit, type Entry, type Hit, type Page } from '@ctx/core';

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
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS decisions(
          key TEXT NOT NULL, revision INTEGER NOT NULL, text TEXT NOT NULL,
          archiveId TEXT NOT NULL REFERENCES entries(id), line INTEGER NOT NULL,
          createdAt TEXT NOT NULL, PRIMARY KEY(key, revision)
        )
      `);
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decision_terms'").get()) {
        this.db.exec(`
          CREATE VIRTUAL TABLE decision_terms USING fts5(key, text, revision UNINDEXED);
          INSERT INTO decision_terms(key, text, revision)
          SELECT d.key, d.text, d.revision FROM decisions d
          WHERE d.revision = (SELECT max(revision) FROM decisions WHERE key=d.key);
          CREATE TRIGGER index_decision AFTER INSERT ON decisions BEGIN
            DELETE FROM decision_terms
            WHERE key=new.key AND decision_terms MATCH ('key:"' || replace(new.key, '"', '""') || '"');
            INSERT INTO decision_terms(key, text, revision) VALUES (new.key, new.text, new.revision);
          END;
        `);
      }
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

  saveDecision({ key, text, archiveId, line }: DecisionDraft, expectedRevision: number): Decision {
    const entry = this.db.prepare('SELECT lines FROM entries WHERE id=?').get(archiveId);
    if (!entry) throw new Error('Unknown evidence archive ID');
    if (line < 1 || line > Number(entry.lines)) throw new Error('Evidence line outside archive');

    const saved = this.db.prepare(`
      INSERT INTO decisions(key, revision, text, archiveId, line, createdAt)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE ? = COALESCE((SELECT max(revision) FROM decisions WHERE key=?), 0)
      RETURNING *
    `).get(key, expectedRevision + 1, text, archiveId, line, new Date().toISOString(), expectedRevision, key);
    if (!saved) throw new Error('Decision revision conflict. Read the current revision before retrying.');
    return saved as unknown as Decision;
  }

  readDecision(key: string, revision?: number): Decision {
    const row = revision === undefined
      ? this.db.prepare('SELECT * FROM decisions WHERE key=? ORDER BY revision DESC LIMIT 1').get(key)
      : this.db.prepare('SELECT * FROM decisions WHERE key=? AND revision=?').get(key, revision);
    if (!row) throw new Error('Decision or revision not found');
    return row as unknown as Decision;
  }

  listDecisions(after: string, limit: number): Pick<Decision, 'key' | 'revision'>[] {
    return this.db.prepare(`
      SELECT key, max(revision) AS revision FROM decisions
      WHERE key > ? GROUP BY key ORDER BY key LIMIT ?
    `).all(after, limit) as unknown as Pick<Decision, 'key' | 'revision'>[];
  }

  searchDecisions(expression: string, limit: number): DecisionHit[] {
    return this.db.prepare(`
      SELECT d.key, d.revision, d.archiveId, d.line,
        substr(snippet(decision_terms, 1, '', '', '…', 16), 1, 240) AS excerpt
      FROM decision_terms JOIN decisions d ON d.key=decision_terms.key AND d.revision=decision_terms.revision
      WHERE decision_terms MATCH ?
      ORDER BY rank, d.key LIMIT ?
    `).all(expression, limit) as unknown as DecisionHit[];
  }

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
