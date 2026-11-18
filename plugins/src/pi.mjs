import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { database, node, runtime, wrap } from './native.mjs';

// The builder snapshots the packaged MCP server's tools/list at build time.
const tools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));

export default function contactsheet(pi) {
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const command = wrap(event.input, ctx.sessionManager?.getSessionId?.(), ctx.cwd);
    if (command) event.input.command = command;
  });
  for (const { name, description, inputSchema } of tools) {
    let parameters = inputSchema;
    if (pi.zod) {
      // OMP provides its schema builder in the extension API.
      const fields = {};
      for (const [key, field] of Object.entries(inputSchema.properties)) {
        const value = field.type === 'integer' ? pi.zod.number().int() : pi.zod.string();
        fields[key] = inputSchema.required?.includes(key) ? value : value.optional();
      }
      parameters = pi.zod.object(fields);
    }
    pi.registerTool({
      name, label: name, description, parameters,
      async execute(_callId, args, signal, _update, ctx) {
        const client = new Client({ name: 'contactsheet-tools', version: '1' });
        try {
          await client.connect(new StdioClientTransport({
            command: node, args: [runtime, 'serve', '--db', database(ctx.cwd)], cwd: ctx.cwd,
          }));
          const reply = await client.callTool({ name, arguments: args }, undefined, { signal });
          if (reply.isError) throw new Error(reply.content[0]?.text ?? 'ContactSheet tool failed');
          return { content: reply.content, details: reply.structuredContent ?? {} };
        } finally {
          await client.close();
        }
      },
    });
  }
}
