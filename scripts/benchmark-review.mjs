// Optional local-model comparison. Each invocation of lms chat starts a fresh conversation.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const model = process.argv[2];
if (!model) throw new Error('Supply the identifier of an installed LM Studio model');
const cli = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'contactsheet-review-'));
const task = `Review this proposed JavaScript change before release. Give actionable findings in 150 words or fewer.

The old worker awaited delivery and only then deleted a queue item. On failure the scheduler retries it.
The new worker is intended to process up to five pending items per invocation. pending() resolves
to an array of items. deliver() and remove() both return promises.
async function flush(queue, deliver) {
  const pending = await queue.pending();
  pending.slice(0, 5).forEach(async item => {
    await queue.remove(item.id);
    await deliver(item);
  });
}`;
try {
  const read = arg => JSON.parse(execFileSync(process.execPath, [cli, 'coding', arg, '--db', join(temp, 'bench.sqlite')]));
  const policy = read('full').instructions + '\n' + read('review').workflow;
  for (const [mode, extra] of [['baseline', ''], ['guided', policy]]) {
    console.log('\n' + mode);
    const instructions = ['You are reviewing a code change.', extra].filter(Boolean).join('\n');
    execFileSync('lms', ['chat', model, '--prompt', task, '--system-prompt', instructions,
      '--reasoning', 'off', '--dont-fetch-catalog', '--ttl', '120', '--stats', '-y'], { stdio: 'inherit' });
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
