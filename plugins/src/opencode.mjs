import { database, node, runtime, wrap } from './native.mjs';

function server(cwd) {
  return { type: 'local', command: [node, runtime, 'serve', '--db', database(cwd)] };
}

export default {
  id: 'contactsheet',
  async setup(ctx) {
    const cwd = ctx.location.directory;
    await ctx.mcp.transform(editor => editor.set('contactsheet', server(cwd)));
    await ctx.tool.hook('execute.before', event => {
      if (event.tool !== 'bash' || !event.input) return;
      const command = wrap(event.input, event.sessionID, cwd);
      if (command) event.input = { ...event.input, command };
    });
  },
  async server({ directory }) {
    return {
      async config(config) {
        config.mcp ??= {};
        config.mcp.contactsheet = server(directory);
      },
      async 'tool.execute.before'(event, output) {
        if (event.tool !== 'bash') return;
        const command = wrap(output.args, event.sessionID, directory);
        if (command) output.args.command = command;
      },
    };
  },
};
