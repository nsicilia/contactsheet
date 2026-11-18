import { createReadStream } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SqliteArchive } from '@ctx/storage';

export async function importSessions(directory: string, archive: SqliteArchive) {
  let imported = 0, skippedLines = 0;
  async function visit(path: string) {
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.jsonl'))) await visit(join(path, entry.name));
      }
      return;
    }
    if (!info.isFile() || !path.endsWith('.jsonl')) return;
    const usage = new Map<string, number>();
    let cost = 0, duration = 0, hasCost = false, hasDuration = false;
    const stream = createReadStream(path);
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        let event;
        try { event = JSON.parse(line); } catch { skippedLines++; continue; }
        const message = event?.message;
        if (event?.type === 'assistant' && typeof message?.id === 'string' && message.usage) {
          const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
          const values = fields.map(key => message.usage[key] ?? 0);
          if (values.every(value => Number.isSafeInteger(value) && value >= 0)) {
            usage.set(message.id, Math.max(usage.get(message.id) ?? 0, values.reduce((a, b) => a + b, 0)));
          }
        }
        if (event?.type === 'result') {
          if (Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0) { cost = event.total_cost_usd; hasCost = true; }
          if (Number.isFinite(event.duration_api_ms) && event.duration_api_ms >= 0) { duration = event.duration_api_ms; hasDuration = true; }
        }
      }
    } finally { stream.destroy(); }
    if (usage.size || hasCost || hasDuration) {
      const id = createHash('sha256').update(path).digest('hex');
      archive.recordSession(id, usage.size ? [...usage.values()].reduce((a, b) => a + b, 0) : null,
        hasCost ? cost : null, hasDuration ? duration : null);
      imported++;
    }
  }
  await visit(directory);
  return { imported, skippedLines, totals: archive.boardTotals() };
}
