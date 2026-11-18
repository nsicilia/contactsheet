import { prefix } from '@ctx/core';

type Agent = 'claude' | 'codex' | 'gemini';

const bashHook = { event: 'PreToolUse', tool: 'Bash' };
const shellHooks = {
  claude: bashHook,
  codex: bashHook,
  gemini: { event: 'BeforeTool', tool: 'run_shell_command' },
};

export function agentName(value: string | undefined): Agent {
  if (value !== 'claude' && value !== 'codex' && value !== 'gemini') throw new Error('Expected claude, codex or gemini');
  return value;
}

function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function mcpConfig(cli: string, db: string) {
  return { mcpServers: { contactsheet: { command: process.execPath, args: [cli, 'serve', '--db', db] } } };
}

export function hookConfig(agent: Agent, cli: string, db: string) {
  const command = [process.execPath, cli, 'hook', agent, '--db', db].map(quote).join(' ');
  const { event, tool } = shellHooks[agent];
  const hooks = { [event]: [{ matcher: '^' + tool + '$', hooks: [{ type: 'command', command }] }] };
  return agent === 'gemini' ? { hooks, ...mcpConfig(cli, db) } : { hooks };
}

// Match simple foreground invocations only. Shell syntax, pipelines and the
// rewritten command are deliberately outside this grammar.
const runner = /^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:test(?::[\w-]+)?|build(?::[\w-]+)?|lint|typecheck)|(?:cargo|go) (?:test|build|check)|node --test|pytest|python3? -m pytest|make (?:test|build|check))(?: [a-zA-Z0-9_./:=@+-]+)*$/;

export function route(agent: Agent, event: Record<string, unknown>, cli: string, db: string) {
  const input = event.tool_input as Record<string, unknown> | undefined;
  const shell = shellHooks[agent];
  if (process.platform === 'win32' || event.hook_event_name !== shell.event || event.tool_name !== shell.tool || !input) return {};
  if (input.tty || input.run_in_background || input.is_background || typeof input.command !== 'string') return {};
  const cmd = input.command.trim();
  if (!runner.test(cmd) || /(?:^|[ :])(?:--?watch(?:All)?|watch)(?:$|[ =:])/.test(cmd)) return {};
  const session = typeof event.session_id === 'string' ? prefix(event.session_id.replaceAll('\0', ''), 256) : '';
  const filter = [process.execPath, cli, 'capture', '--db', db, '--source', prefix(cmd, 256), '--session', session];
  const command = `(set -o pipefail && ${cmd} 2>&1 | ${filter.map(quote).join(' ')})`;
  if (agent === 'gemini') {
    return { hookSpecificOutput: { hookEventName: 'BeforeTool', tool_input: { ...input, command } } };
  }
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    ...(agent === 'codex' ? { permissionDecision: 'allow' } : {}),
    updatedInput: { ...input, command },
  } };
}
