import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ContextEngine, maxBytes } from '@ctx/core';
import type { SqliteArchive } from '@ctx/storage';

const passthroughBytes = 4096;

// Spool first. A producer can exceed the index limits or emit invalid UTF-8.
// Keep its exact bytes available even if indexing fails after the command ran.
export async function capture(db: string, source: string, session: string, open: () => SqliteArchive) {
  const parent = dirname(db);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, 'capture-'));
  const raw = join(dir, 'output');
  await pipeline(process.stdin, createWriteStream(raw, { flags: 'wx', mode: 0o600 }));
  try {
    const { size } = await stat(raw);
    if (size > maxBytes) throw new Error('Output exceeds the 8 MiB search index limit');
    const bytes = await readFile(raw);
    if (size <= passthroughBytes) {
      process.stdout.write(bytes);
    } else {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const archive = open();
      try {
        const { id, lines, preview } = new ContextEngine(archive).index(text, source, session);
        console.log(JSON.stringify({ id, bytes: size, lines, preview, retrieve: 'context_search / context_read' }));
      } finally {
        archive.close();
      }
    }
  } catch (error) {
    console.log(JSON.stringify({ rawFile: raw, indexed: false, reason: error instanceof Error ? error.message : String(error) }));
    return;
  }
  await unlink(raw);
  await rmdir(dir);
}
