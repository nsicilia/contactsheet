import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { maxBytes, type ContextEngine } from '@ctx/core';

const id = z.string().regex(/^ctx_[a-f0-9]{64}$/);
const label = z.string().max(256);
const decisionKey = z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createServer(engine: ContextEngine) {
  const policy = engine.coding();
  const server = new McpServer({ name: 'contactsheet', version: '0.1.0' }, { instructions: 'ContactSheet coding mode: ' + policy.level + '. ' + policy.instructions + ' Consult context_coding for the current policy before coding or when the user changes mode.' });
  server.registerTool('context_coding', {
    description: 'Get the current coding policy. Set level only on explicit request. Request review, audit, debt, gain or help instructions with action.',
    inputSchema: { level: z.enum(['lite', 'full', 'ultra', 'off']).optional(), action: z.enum(['review', 'audit', 'debt', 'gain', 'help']).optional() },
  }, ({ level, action }) => result(engine.coding(level, action)));
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
  server.registerTool('context_decision_save', {
    description: 'Record an agreed project decision and its rationale with an evidence archive ID and line. Use expectedRevision 0 to create, or the current revision to append a revision. Earlier revisions are preserved.',
    inputSchema: {
      key: decisionKey.describe('Stable, lowercase decision key such as build-timeout'),
      text: z.string().trim().min(1).max(4096).refine(text => text.isWellFormed() && !text.includes('\0')),
      archiveId: id, line: z.number().int().positive().max(100000),
      expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
    },
  }, ({ expectedRevision, ...draft }) => result(engine.saveDecision(draft, expectedRevision)));
  server.registerTool('context_decision_read', {
    description: 'Read the current project decision by key, or a specific earlier revision, including the source archive ID and line for context_read.',
    inputSchema: { key: decisionKey, revision: z.number().int().positive().optional() },
  }, ({ key, revision }) => result(engine.readDecision(key, revision)));
  server.registerTool('context_decision_list', {
    description: 'List up to 20 project decision keys and their current revisions. Pass the returned next key as after to continue.',
    inputSchema: { after: decisionKey.optional() },
  }, ({ after }) => result(engine.listDecisions(after)));
  return server;
}

export async function serve(engine: ContextEngine) {
  const server = createServer(engine);
  await server.connect(new StdioServerTransport());
  return server;
}
