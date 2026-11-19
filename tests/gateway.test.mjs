import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const cli = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));
const content = (role, part) => ({ role, parts: [part] });

test('Gemini gateway budgets a conversation, streams a tool call and preserves its result', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'contactsheet-gateway-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const counts = [], generations = [];
  const firstChunk = 'data: ' + JSON.stringify({ candidates: [{ content: content('model', { functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'abc' }) }] }) + '\n\n';
  const lastChunk = 'data: {"usageMetadata":{"promptTokenCount":200,"cachedContentTokenCount":40}}\n\n';
  let finishStream;
  const gate = new Promise(resolve => { finishStream = resolve; });
  t.after(finishStream);
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const piece of req) raw += piece;
    const body = JSON.parse(raw);
    if (req.headers['x-goog-api-key'] !== 'fixture') { res.writeHead(403).end('{}'); return; }
    if (req.url.endsWith(':countTokens')) {
      const tokens = Math.ceil(JSON.stringify(body.generateContentRequest ?? body).length / 4);
      counts.push(tokens);
      res.end(JSON.stringify({ totalTokens: tokens }));
    } else {
      generations.push(body);
      if (req.url.endsWith('streamGenerateContent?alt=sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }).write(firstChunk);
        await gate;
        res.end(lastChunk);
      } else res.end(JSON.stringify({ candidates: [{ content: content('model', { text: 'done' }) }] }));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const db = join(dir, 'archive.sqlite');
  const child = spawn(process.execPath, [cli, 'gateway', '--db', db, '--budget', '400', '--port', '0',
    '--upstream', 'http://127.0.0.1:' + upstream.address().port], { stdio: ['ignore','ignore','pipe'] });
  t.after(() => child.kill());
  const [ready] = await Promise.race([once(child.stderr, 'data'), once(child, 'exit').then(() => { throw new Error('Gateway exited'); })]);
  const url = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/)[0] + '/v1beta/models/gemini-test:';
  const rpc = (method, body, key = 'fixture') => fetch(url + method, { method: 'POST', headers: { 'x-goog-api-key': key }, body: JSON.stringify(body) });
  const original = content('model', { text: 'archived receipt '.repeat(400) });
  const request = { systemInstruction: { parts: [{ text: 'Keep evidence.' }] }, tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    contents: [content('user', { text: 'Remember this.' }), original, content('user', { text: 'Look it up.' })] };
  const start = performance.now();
  const stream = await rpc('streamGenerateContent?alt=sse', request);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  let bytes = '';
  while (!bytes.endsWith('\n\n')) bytes += Buffer.from((await reader.read()).value);
  assert.equal(bytes, firstChunk);
  const firstMs = Math.round(performance.now() - start);
  finishStream();
  while (true) { const r = await reader.read(); if (r.done) break; bytes += Buffer.from(r.value); }
  assert.equal(bytes, firstChunk + lastChunk);
  const usage = JSON.parse(lastChunk.slice(6)).usageMetadata;
  assert.equal(usage.cachedContentTokenCount, 40);
  const id = generations[0].contents[1].parts[0].text.match(/ctx_[a-f0-9]{64}/)[0];
  const recovered = JSON.parse(execFileSync(process.execPath, [cli, 'read', id, '--db', db]));
  assert.deepEqual(JSON.parse(recovered.text), original);
  const call = JSON.parse(firstChunk.slice(6)).candidates[0].content;
  request.contents.push(call, content('user', { functionResponse: { name: 'lookup', response: { value: 3 } } }));
  const final = await rpc('generateContent', request);
  assert.equal((await final.json()).candidates[0].content.parts[0].text, 'done');
  const expected = structuredClone(request);
  expected.contents[1] = generations[0].contents[1];
  assert.deepEqual(generations[1], expected);
  assert.ok(counts[0] > 400 && counts[1] <= 400 && counts[3] <= 400);
  const short = { cachedContent: 'cachedContents/fixture', contents: [content('user', { text: 'hi' })] };
  assert.equal((await rpc('generateContent', short)).status, 200);
  assert.deepEqual(generations[2], short);
  assert.equal((await rpc('generateContent', short, 'bad')).status, 403);
  assert.equal((await rpc('generateContent', { contents: [content('user', { text: 'x'.repeat(3000) })] })).status, 413);
  assert.equal(generations.length, 3);
  const counter = await rpc('countTokens', { generateContentRequest: short });
  assert.equal((await counter.json()).totalTokens, Math.ceil(JSON.stringify(short).length / 4));
  t.diagnostic(`Fixture count ${counts[0]} → ${counts[1]}, first streamed event ${firstMs} ms; provider cache field ${usage.cachedContentTokenCount} forwarded`);
});

for (const provider of ['openai', 'anthropic']) {
  test(provider + ' counts, archives and recovers text while preserving tool exchanges', { timeout: 10000 }, async t => {
    const { gateway } = await import('../apps/cli/dist/gateway.js');
    const { ContextEngine } = await import('../packages/core/dist/index.js');
    const { SqliteArchive } = await import('../packages/storage/dist/index.js');
    const store = new SqliteArchive(':memory:');
    t.after(() => store.close());
    const engine = new ContextEngine(store);
    const calls = [];
    const upstream = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls.push({ url: req.url, headers: req.headers, body });
      if (req.headers.authorization === 'Bearer denied') res.writeHead(401).end('denied');
      else if (req.url.includes('_tokens')) res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
      else res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: fixture\n\n');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const proxy = await gateway(engine, 400, 0, 'http://127.0.0.1:' + upstream.address().port, provider);
    t.after(() => { for (const s of [proxy, upstream]) { s.closeAllConnections(); s.close(); } });
    const oa = provider === 'openai';
    const path = oa ? '/v1/responses' : '/v1/messages';
    const counter = path + (oa ? '/input_tokens' : '/count_tokens');
    const url = 'http://127.0.0.1:' + proxy.address().port;
    const headers = oa ? { authorization: 'Bearer fixture' } : { 'x-api-key': 'fixture', 'anthropic-version': '2023-06-01' };
    const post = (route, data, auth = headers) => fetch(url + route, { method: 'POST', headers: auth, body: JSON.stringify(data) });
    const old = { role: 'assistant', content: [{ type: oa ? 'output_text' : 'text', text: 'historical answer '.repeat(180) }] };
    const history = [{ role: 'user', content: 'Remember' }, old, { role: 'user', content: 'Run lookup' },
      ...(oa ? [{ type: 'function_call', call_id: 'c', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c', output: '42' }] : [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'lookup', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: '42' }] }])];
    const key = oa ? 'input' : 'messages';
    const body = { model: 'fixture', [key]: history, [oa ? 'instructions' : 'system']: 'Keep instructions', stream: true };
    const result = await post(path, body);
    assert.equal(await result.text(), 'data: fixture\n\n');
    assert.equal(result.headers.get('x-contactsheet-archived'), '1');
    assert.ok(Number(result.headers.get('x-contactsheet-input-tokens')) <= 400);
    assert.deepEqual(calls.map(c => c.url), [counter, counter, path]);
    for (const { headers: received } of calls) {
      for (const [k,v] of Object.entries(headers)) assert.equal(received[k], v);
    }
    assert.equal(calls[0].body.stream, undefined);
    const forwarded = calls.at(-1).body;
    const marker = forwarded[key][1];
    const id = marker.content[0].text.match(/ctx_[a-f0-9]{64}/)[0];
    assert.deepEqual(JSON.parse(engine.read(id).text), old);
    assert.deepEqual(forwarded, { ...body, [key]: [history[0], marker, ...history.slice(2)] });
    assert.equal((await post(counter, calls[0].body)).status, 200);
    assert.equal((await post(path, body, { authorization: 'Bearer denied' })).status, 401);
    assert.equal((await post(path, { ...body, [key]: [{ role: 'user', content: 'x'.repeat(4000) }] })).status, 413);
    assert.equal(calls.filter(c => c.url === path).length, 1);
  });
}
