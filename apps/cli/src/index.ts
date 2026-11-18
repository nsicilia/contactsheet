#!/usr/bin/env node
import { closeSync, mkdirSync, openSync, createReadStream } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, TextDecoder } from 'node:util';
import { ContextEngine, maxBytes } from '@ctx/core';
import { SqliteArchive } from '@ctx/storage';
import { capture } from './capture.js';
import { agentName, hookConfig, mcpConfig, route } from './hooks.js';

const usage = `contactsheet init
contactsheet index [file] [--source label] [--session label]    (defaults to stdin)
contactsheet search <query> [--id archive-id] [--limit n]
contactsheet read <archive-id> [--line n] [--count n] [--offset n]
contactsheet serve
contactsheet hook-config <claude|codex|gemini>
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

function openArchive(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return new SqliteArchive(path);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log(usage);
    return;
  }
  const flags: Record<string, string[]> = {
    init: [], serve: [], 'hook-config': [], hook: [],
    capture: ['source', 'session'], index: ['source', 'session'],
    search: ['id', 'limit'], read: ['line', 'count', 'offset'],
  };
  if (!Object.hasOwn(flags, command)) throw new Error(usage);
  const options = Object.fromEntries(['db', ...flags[command]!].map(key => [key, { type: 'string' as const }]));
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  const arity = ['search', 'read', 'hook-config', 'hook'].includes(command) ? 1 : 0;
  if (positionals.length < arity || positionals.length > (command === 'index' ? 1 : arity)) throw new Error(usage);

  const path = resolve(values.db ?? process.env.CONTEXT_DB ?? '.context/archive.sqlite');
  const cli = fileURLToPath(import.meta.url);
  if (command === 'hook-config' || command === 'hook') {
    const agent = agentName(positionals[0]);
    const result = command === 'hook-config' ? hookConfig(agent, cli, path)
      : route(agent, JSON.parse(await readInput()), cli, path);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'capture') {
    await capture(path, values.source ?? 'shell', values.session ?? '', () => openArchive(path));
    return;
  }
  const archive = openArchive(path);
  const engine = new ContextEngine(archive);
  try {
    let output: unknown;
    switch (command) {
      case 'init':
        output = mcpConfig(cli, path);
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
        const { serve } = await import('@ctx/mcp');
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
