#!/usr/bin/env node
import { closeSync, mkdirSync, openSync, createReadStream } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, TextDecoder } from 'node:util';
import { ContextEngine, maxBytes } from '@ctx/core';
import { SqliteArchive } from '@ctx/storage';
import { serve } from '@ctx/mcp';

const usage = `contactsheet init
contactsheet index [file] [--source label] [--session label]    (defaults to stdin)
contactsheet search <query> [--id archive-id] [--limit n]
contactsheet read <archive-id> [--line n] [--count n] [--offset n]
contactsheet serve
Use --db <path> with any command, or set CONTEXT_DB. Default: .context/archive.sqlite`;

async function readInput(file?: string) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of file ? createReadStream(file) : process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Input exceeds 8 MiB');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log(usage);
    return;
  }
  const flags: Record<string, string[]> = {
    init: [], serve: [], index: ['source', 'session'], search: ['id', 'limit'], read: ['line', 'count', 'offset'],
  };
  if (!Object.hasOwn(flags, command)) throw new Error(usage);
  const options = Object.fromEntries(['db', ...flags[command]!].map(key => [key, { type: 'string' as const }]));
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  const arity = command === 'search' || command === 'read' ? 1 : 0;
  if (positionals.length < arity || positionals.length > (command === 'index' ? 1 : arity)) throw new Error(usage);

  const path = resolve(values.db ?? process.env.CONTEXT_DB ?? '.context/archive.sqlite');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const archive = new SqliteArchive(path);
  const engine = new ContextEngine(archive);
  try {
    let output: unknown;
    switch (command) {
      case 'init':
        output = { mcpServers: { 'contactsheet': {
          command: process.execPath, args: [fileURLToPath(import.meta.url), 'serve', '--db', path],
        } } };
        break;
      case 'index': {
        const file = positionals[0];
        output = engine.index(await readInput(file), values.source ?? (file ? basename(file) : 'stdin'), values.session);
        break;
      }
      case 'search':
        output = engine.search(positionals[0]!, Number(values.limit ?? 10), values.id);
        break;
      case 'read':
        output = engine.read(positionals[0]!, Number(values.line ?? 1), Number(values.count ?? 20), Number(values.offset ?? 0));
        break;
      case 'serve': {
        const server = await serve(engine);
        await new Promise<void>(done => process.stdin.once('end', done));
        await server.close();
        return;
      }
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    archive.close();
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
