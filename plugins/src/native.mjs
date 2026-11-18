import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCommand } from '../../apps/cli/dist/hooks.js';

export const runtime = fileURLToPath(new URL('./contactsheet.mjs', import.meta.url));
export const node = process.versions.bun ? 'node' : process.execPath;

export function database(cwd) {
  return resolve(cwd, process.env.CONTEXT_DB ?? '.context/archive.sqlite');
}

export function wrap(input, session, cwd) {
  return captureCommand(input, session, runtime, database(cwd), node);
}
