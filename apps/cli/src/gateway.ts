import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { type ContextEngine, maxBytes } from '@ctx/core';

class GatewayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function jsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new GatewayError(413, 'Request exceeds 8 MiB');
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (object(body)) return body;
  } catch { /* Return a client error for malformed JSON or UTF-8. */ }
  throw new GatewayError(400, 'Expected a JSON object');
}

// Keep every user message and the entire active exchange (including function responses).
function compactHistory(contents: unknown[], engine: ContextEngine) {
  const active = contents.findLastIndex(turn => object(turn) && (turn.role === 'user' || !turn.role)
    && Array.isArray(turn.parts) && turn.parts.some(part => object(part) && !('functionResponse' in part)));
  let archived = 0;
  for (let i = 0; i < active; i++) {
    const turn = contents[i];
    if (!object(turn) || turn.role !== 'model' || Object.keys(turn).length !== 2 || !Array.isArray(turn.parts)
      || !turn.parts.length || !turn.parts.every(p => object(p) && Object.keys(p).length === 1 && typeof p.text === 'string')) continue;
    const original = JSON.stringify(turn);
    if (Buffer.byteLength(original) < 512) continue;
    const { id } = engine.index(original, 'gemini:model');
    contents[i] = { role: 'model', parts: [{ text: '[Archived model reply. Use context_read with id ' + id + ' for the original Gemini turn.]' }] };
    archived++;
  }
  return archived;
}

function compactMessages(items: unknown[], provider: string, engine: ContextEngine) {
  const active = items.findLastIndex(item => object(item) && item.role === 'user' &&
    (typeof item.content === 'string' || (Array.isArray(item.content) && item.content.length > 0 &&
      !item.content.some(block => object(block) && block.type === 'tool_result'))));
  let archived = 0;
  for (const item of items.slice(0, Math.max(0, active))) {
    if (!object(item) || item.role !== 'assistant' || (item.type !== undefined && item.type !== 'message')) continue;
    const blocks = item.content;
    const textType = provider === 'openai' ? 'output_text' : 'text';
    if (typeof blocks !== 'string' && !(Array.isArray(blocks) && blocks.length &&
      blocks.every(b => object(b) && b.type === textType && typeof b.text === 'string' &&
        Object.keys(b).every(k => k === 'text' || k === 'type' ||
          (k === 'annotations' && Array.isArray(b.annotations) && !b.annotations.length))))) continue;
    const original = JSON.stringify(item);
    if (Buffer.byteLength(original) < 512) continue;
    const { id } = engine.index(original, provider + ':assistant');
    const text = '[Archived assistant reply. Use context_read with id ' + id + ' for the original turn.]';
    item.content = typeof blocks === 'string' ? text : [{ ...blocks[0], text }];
    archived++;
  }
  return archived;
}

const origins = {
  gemini: 'https://generativelanguage.googleapis.com', openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com',
};

async function relay(res: ServerResponse, upstream: Response, signal: AbortSignal) {
  res.statusCode = upstream.status;
  for (const header of ['content-type', 'cache-control', 'retry-after']) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.flushHeaders();
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  async function* chunks() {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        yield chunk.value;
      }
    } finally { reader.releaseLock(); }
  }
  await pipeline(chunks(), res, { signal });
}

export async function gateway(engine: ContextEngine, budget: number, port: number, origin?: string, provider = 'gemini') {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Expected a positive --budget in input tokens');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (!Object.hasOwn(origins, provider)) throw new Error('Expected --provider gemini, openai or anthropic');
  const base = new URL(origin ?? origins[provider as keyof typeof origins]);
  if (base.href !== base.origin + '/' || !(base.protocol === 'https:' ||
    (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error('Upstream must be an HTTPS origin or local HTTP origin');
  }
  const server = createServer(async (req, res) => {
    const start = performance.now();
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
    let before: number | undefined, after: number | undefined, archived = 0;
    try {
      if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
        throw new GatewayError(403, 'Local SDK clients only');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const gemini = provider === 'gemini';
      const openai = provider === 'openai';
      const route = /^\/(v1(?:beta)?)\/(models\/[a-zA-Z0-9._-]+):(generateContent|streamGenerateContent|countTokens)$/.exec(url.pathname);
      const generation = openai ? '/v1/responses' : '/v1/messages';
      const counter = gemini && route ? '/' + route[1] + '/' + route[2] + ':countTokens'
        : generation + (openai ? '/input_tokens' : '/count_tokens');
      if (req.method !== 'POST' || (gemini ? !route : ![generation, counter].includes(url.pathname))) {
        throw new GatewayError(404, 'Unknown gateway route');
      }
      const body = await jsonBody(req);
      const headers = new Headers({ 'content-type': 'application/json' });
      if (gemini) {
        const key = req.headers['x-goog-api-key'] ?? url.searchParams.get('key');
        if (typeof key === 'string') headers.set('x-goog-api-key', key);
      }
      const providerHeaders = openai ? ['openai-organization', 'openai-project', 'openai-beta']
        : gemini ? [] : ['x-api-key', 'anthropic-version', 'anthropic-beta'];
      for (const name of ['authorization', ...providerHeaders]) {
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      }
      const query = gemini ? 'alt' : 'beta';
      const value = url.searchParams.get(query);
      const suffix = value ? '?' + query + '=' + encodeURIComponent(value) : '';
      const post = (path: string, payload: unknown) => fetch(base.origin + path, {
        method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error',
      });
      if (url.pathname === counter) {
        await relay(res, await post(url.pathname + suffix, body), signal);
        return;
      }
      const history = body[gemini ? 'contents' : openai ? 'input' : 'messages'];
      if (!(Array.isArray(history) && history.length) && !(openai && typeof history === 'string')) {
        throw new GatewayError(400, 'Expected explicit conversation history');
      }
      if (openai && (body.previous_response_id || body.conversation || body.prompt)) {
        throw new GatewayError(400, 'Budgeting requires explicit history and instructions');
      }
      const count = async () => {
        const fields = openai ? ['model', 'input', 'instructions', 'tools', 'tool_choice', 'text', 'reasoning', 'truncation']
          : ['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'context_management', 'mcp_servers', 'output_config', 'cache_control'];
        const payload = gemini ? { generateContentRequest: { ...body, model: route![2] } }
          : Object.fromEntries(fields.filter(key => key in body).map(key => [key, body[key]]));
        const response = await post(counter + (gemini ? '' : suffix), payload);
        if (!response.ok) {
          await relay(res, response, signal);
          return;
        }
        const data: unknown = await response.json();
        const tokens = object(data) && data[gemini ? 'totalTokens' : 'input_tokens'];
        if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
          throw new GatewayError(502, 'Invalid provider token count');
        }
        return tokens;
      };
      before = after = await count();
      if (before === undefined) return;
      if (before > budget) {
        if (Array.isArray(history)) archived = gemini ? compactHistory(history, engine) : compactMessages(history, provider, engine);
        if (archived) after = await count();
        if (after === undefined) return;
        if (after > budget) throw new GatewayError(413, 'Protected context exceeds the input budget');
      }
      res.setHeader('x-contactsheet-input-tokens', String(after));
      res.setHeader('x-contactsheet-archived', String(archived));
      const upstream = await post(url.pathname + suffix, body);
      await relay(res, upstream, signal);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const status = error instanceof GatewayError ? error.status : 502;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: status, message: error instanceof GatewayError ? error.message : 'Gateway request failed' } }));
      }
    } finally {
      console.error(JSON.stringify({ status: res.statusCode, before, after, archived, elapsedMs: Math.round(performance.now() - start) }));
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
