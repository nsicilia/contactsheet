import { readFileSync } from 'node:fs';

export function compare(files: string[]) {
  const [baseline, guided] = files.map(file => JSON.parse(readFileSync(file, 'utf8')));
  if (!baseline?.task || typeof baseline.task !== 'string' || baseline.task !== guided?.task) {
    throw new Error('Both measurements must name the same task');
  }
  if (baseline.passed !== true || guided.passed !== true) throw new Error('Both runs must pass their acceptance checks');
  const metrics: Record<string, unknown> = {};
  for (const key of ['lines', 'tokens', 'seconds', 'costUSD']) {
    const before = baseline[key], after = guided[key];
    for (const value of [before, after]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid measurement: ' + key);
    }
    if (before === undefined || after === undefined) continue;
    metrics[key] = { baseline: before, guided: after, saved: before - after,
      percentSaved: before === 0 ? null : Number(((before - after) / before * 100).toFixed(2)) };
  }
  if (!Object.keys(metrics).length) throw new Error('Supply at least one shared metric');
  return { task: baseline.task, metrics };
}
