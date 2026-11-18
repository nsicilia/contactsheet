import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { maxBytes, type ContextEngine } from '@ctx/core';

const id = z.string().regex(/^ctx_[a-f0-9]{64}$/);
const label = z.string().max(256);
function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createServer(engine: ContextEngine) {
  const server = new McpServer({ name: 'contactsheet', version: '0.1.0' });
  server.registerTool('context_index', {
    description: 'Archive supplied log text and return its stable ID, metadata and bounded preview.',
    inputSchema: { text: z.string().max(maxBytes), source: label.optional(), session: label.optional() },
  }, ({ text, source, session }) => result(engine.index(text, source ?? 'mcp', session)));
  server.registerTool('context_search', {
    description: 'Find ranked original line numbers matching all query words. Optionally restrict to one archive ID.',
    inputSchema: { query: z.string().min(1).max(256), limit: z.number().int().min(1).max(50).optional(), id: id.optional() },
  }, ({ query, limit, id }) => {
    const hits = engine.search(query, limit, id);
    return { ...result(hits), structuredContent: { hits } };
  });
  server.registerTool('context_read', {
    description: 'Read exact original text starting at a 1-based line. Continue with the returned next.line and next.offset.',
    inputSchema: {
      id, line: z.number().int().positive().optional(), count: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
  }, ({ id, line, count, offset }) => result(engine.read(id, line, count, offset)));
  return server;
}

export async function serve(engine: ContextEngine) {
  const server = createServer(engine);
  await server.connect(new StdioServerTransport());
  return server;
}
