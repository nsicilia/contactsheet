import { prefix } from '@ctx/core';

type Agent = keyof typeof shellHooks;

const bashHook = { event: 'PreToolUse', tool: 'Bash' };
const shellHooks = {
  claude: bashHook,
  codex: bashHook,
  zcode: bashHook,
  qwen: { event: 'PreToolUse', tool: 'run_shell_command' },
  copilot: { event: 'preToolUse', tool: 'bash' },
  gemini: { event: 'BeforeTool', tool: 'run_shell_command' },
};

export function agentName(value: string | undefined): Agent {
  if (!value || !Object.hasOwn(shellHooks, value)) throw new Error('Expected one of: ' + Object.keys(shellHooks).join(', '));
  return value as Agent;
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
  if (agent === 'copilot') return { version: 1, hooks: { preToolUse: [{ type: 'command', bash: command }] } };
  const hooks = { [event]: [{ matcher: '^' + tool + '$', hooks: [{ type: 'command', command }] }] };
  return agent === 'gemini' ? { hooks, ...mcpConfig(cli, db) } : { hooks };
}

// Match simple foreground invocations only. Shell syntax, pipelines and the
// rewritten command are deliberately outside this grammar.
const runner = /^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:test(?::[\w-]+)?|build(?::[\w-]+)?|lint|typecheck)|(?:cargo|go) (?:test|build|check)|node --test|pytest|python3? -m pytest|make (?:test|build|check))(?: [a-zA-Z0-9_./:=@+-]+)*$/;

export function captureCommand(input: Record<string, unknown>, sessionId: unknown, cli: string, db: string, node = process.execPath) {
  if (process.platform === 'win32' || input.tty || input.run_in_background || input.is_background || input.mode === 'async' || typeof input.command !== 'string') return;
  const cmd = input.command.trim();
  if (!runner.test(cmd) || /(?:^|[ :])(?:--?watch(?:All)?|watch)(?:$|[ =:])/.test(cmd)) return;
  const session = typeof sessionId === 'string' ? prefix(sessionId.replaceAll('\0', ''), 256) : '';
  const filter = [node, cli, 'capture', '--db', db, '--source', prefix(cmd, 256), '--session', session];
  return `(set -o pipefail && ${cmd} 2>&1 | ${filter.map(quote).join(' ')})`;
}

export function route(agent: Agent, event: Record<string, unknown>, cli: string, db: string) {
  if (agent === 'copilot') {
    if (event.toolName !== 'bash') return {};
    const args = typeof event.toolArgs === 'string' ? JSON.parse(event.toolArgs) : event.toolArgs;
    if (!args || typeof args !== 'object') return {};
    const command = captureCommand(args, event.sessionId, cli, db);
    return command ? { modifiedArgs: { ...args, command } } : {};
  }
  const input = event.tool_input as Record<string, unknown> | undefined;
  const shell = shellHooks[agent];
  if (event.hook_event_name !== shell.event || event.tool_name !== shell.tool || !input) return {};
  const command = captureCommand(input, event.session_id, cli, db);
  if (!command) return {};
  if (agent === 'gemini') {
    return { hookSpecificOutput: { hookEventName: 'BeforeTool', tool_input: { ...input, command } } };
  }
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    ...(agent === 'codex' ? { permissionDecision: 'allow' } : {}),
    updatedInput: { ...input, command },
  } };
}
