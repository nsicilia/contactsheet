import { codingPolicy } from './coding.js';
import { createHash } from 'node:crypto';

export const maxBytes = 8 * 1024 * 1024;
export const previewBudget = 1200;
export const pageBudget = 8192;

export interface Entry {
  id: string;
  hash: string;
  source: string;
  session: string;
  createdAt: string;
  bytes: number;
  lines: number;
}

export interface Cursor { line: number; offset: number }
export interface Page { text: string; next: Cursor | null }
export interface Hit { id: string; source: string; line: number; excerpt: string }

export interface DecisionDraft {
  key: string;
  text: string;
  archiveId: string;
  line: number;
}

export interface Decision extends DecisionDraft {
  revision: number;
  createdAt: string;
}

export type DecisionHit = Pick<Decision, 'key' | 'revision' | 'archiveId' | 'line'> & { excerpt: string };

export interface Archive {
  codingLevel(level?: string): string;
  save(entry: Entry, lines: string[]): Entry;
  search(expression: string, limit: number, id?: string): Hit[];
  read(id: string, cursor: Cursor, count: number): Page;
  saveDecision(draft: DecisionDraft, expectedRevision: number): Decision;
  readDecision(key: string, revision?: number): Decision;
  listDecisions(after: string, limit: number): Pick<Decision, 'key' | 'revision'>[];
  searchDecisions(expression: string, limit: number): DecisionHit[];
}

export function integer(value: number, name: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

// JavaScript offsets count UTF-16 code units. Never cut a surrogate pair in half.
export function prefix(text: string, size: number): string {
  if (text.length <= size) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(size - 1)) ? size - 1 : size;
  return text.slice(0, end);
}

export function compress(lines: string[], budget = previewBudget): string {
  integer(budget, 'budget', 32, 16384);
  if (lines.reduce((sum, line) => sum + line.length, 0) <= budget) return lines.join('');
  const failures = /\b(?:fail(?:ed|ure|ures)?|fatal|panic|exception|error)\b/i;
  const summary = /\b(?:tests?|suites?|passed|warnings?|summary)\b/i;
  const picks = new Map<number, string>();
  let used = 0;
  function add(i: number) {
    if (picks.has(i)) return false;
    const body = lines[i]!.trimEnd();
    if (!body) return false;
    const label = `${i + 1} | `;
    const room = Math.min(174, budget - used - label.length - (picks.size ? 1 : 0));
    if (room < 8) return false;
    const excerpt = body.length > room ? prefix(body, room - 1) + '…' : body;
    picks.set(i, label + excerpt);
    used += label.length + excerpt.length + (picks.size > 1 ? 1 : 0);
    return true;
  }
  let errors = 0;
  for (let i = 0; i < lines.length && errors < 5; i++) {
    const line = lines[i]!;
    if ((failures.test(line) || /(?:Error|Exception)\b/.test(line)) && add(i)) errors++;
  }
  add(lines.length - 1);
  for (let i = lines.length - 1; i >= 0 && picks.size < 8; i--) {
    if (summary.test(lines[i]!)) add(i);
  }
  add(0);
  return [...picks].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n');
}

function sha(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function searchExpression(query: string) {
  if (typeof query !== 'string' || query.length > 256) throw new Error('Query exceeds 256 characters');
  const words = query.match(/[\p{L}\p{N}\p{M}]+/gu);
  if (!words?.length) throw new Error('Enter a search term');
  return words.map(word => '"' + word + '"').join(' AND ');
}

export class ContextEngine {
  constructor(private readonly archive: Archive) {}

  coding(level?: string, action?: string) {
    const current = level ?? this.archive.codingLevel();
    const policy = codingPolicy(current, action);
    if (level !== undefined) this.archive.codingLevel(level);
    return policy;
  }

  index(text: string, source = 'stdin', session = '') {
    if (typeof text !== 'string' || !text.isWellFormed()) throw new Error('Expected Unicode text');
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error('Input exceeds 8 MiB');
    for (const label of [source, session]) {
      if (typeof label !== 'string' || label.length > 256 || !label.isWellFormed() || label.includes('\0')) {
        throw new Error('Invalid source or session label');
      }
    }
    const lines: string[] = [];
    for (const match of text.matchAll(/[^\r\n]+(?:\r\n|\r|\n)?|\r\n|\r|\n/g)) {
      if (lines.length === 100000) throw new Error('Input exceeds 100000 lines');
      lines.push(match[0]);
    }
    const hash = sha(text);
    const entry = this.archive.save({
      id: 'ctx_' + sha(JSON.stringify([hash, source, session])), hash, source, session,
      createdAt: new Date().toISOString(), bytes, lines: lines.length,
    }, lines);
    return { ...entry, preview: compress(lines) };
  }

  search(query: string, limit = 10, id?: string) {
    integer(limit, 'limit', 1, 50);
    return this.archive.search(searchExpression(query), limit, id);
  }

  read(id: string, line = 1, count = 20, offset = 0) {
    integer(line, 'line', 1, 100000);
    integer(count, 'count', 1, 200);
    integer(offset, 'offset', 0, maxBytes);
    return this.archive.read(id, { line, offset }, count);
  }

  saveDecision(draft: DecisionDraft, expectedRevision: number) {
    return this.archive.saveDecision(draft, expectedRevision);
  }

  readDecision(key: string, revision?: number) {
    return this.archive.readDecision(key, revision);
  }

  listDecisions(after = '') {
    const decisions = this.archive.listDecisions(after, 21);
    const hasMore = decisions.length > 20;
    if (hasMore) decisions.pop();
    return { decisions, next: hasMore ? decisions.at(-1)!.key : null };
  }

  searchDecisions(query: string, limit = 10) {
    integer(limit, 'limit', 1, 50);
    return this.archive.searchDecisions(searchExpression(query), limit);
  }
}
