"""Compare raw logs with ContactSheet capture + MCP retrieval on subscription clients."""
import argparse
import json
import secrets
import shlex
import shutil
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

CLI = Path(__file__).resolve().parents[1] / 'apps/cli/dist/index.js'
NODE = shutil.which('node')
CODEX = shutil.which('codex') or next((str(p) for p in [
    Path('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    Path('/Applications/Codex.app/Contents/Resources/codex'),
] if p.is_file()), None)
ERROR = 'ERROR checkout timed out on shard 17'
PROMPT = """Run exactly ./read-fixture once. What failed, and which shipment was affected?
The dispatch record has the shipment reference. If you receive an archive receipt, use
ContactSheet context_search for the dispatch record, then context_read for the original
line. Use no other commands or tools. Reply with exactly two plain text lines: the original
error line without preview numbering, then the shipment reference alone."""


def fixture():
    shipment = 'CS-' + secrets.token_hex(6).upper()
    lines = [f'PASS checkout worker {i}' for i in range(1, 241)]
    lines[42] = f'dispatch record: shipment {shipment} assigned to shard 17'
    lines[116] = ERROR
    return shipment, '\n'.join(lines) + '\n'


def preflight(folder, log, shipment):
    db = str(folder / 'preflight.sqlite')
    def cli(*args, data=None):
        return json.loads(subprocess.check_output(
            [NODE, str(CLI), *args, '--db', db], input=data, text=True))
    receipt = cli('capture', data=log)
    if shipment in json.dumps(receipt) or ERROR not in receipt['preview']:
        raise ValueError('Fixture did not produce the required preview')
    hits = cli('search', 'dispatch record', '--id', receipt['id'])
    line = cli('read', receipt['id'], '--line', str(hits[0]['line']), '--count', '1')
    if shipment not in line['text']:
        raise ValueError('Failed to retrieve shipment from the original line')


def run(host, mode, cwd, log, shipment):
    cwd.mkdir()
    (cwd / 'fixture.log').write_text(log)
    db = str(cwd / 'archive.sqlite')
    server_args = [str(CLI), 'serve', '--db', db]
    wrapper = cwd / 'read-fixture'
    command = ('cat fixture.log' if mode == 'raw' else
               shlex.join([NODE, str(CLI), 'capture', '--db', db]) + ' < fixture.log')
    wrapper.write_text('#!/bin/sh\nset -eu\nprintf x >> calls\n' + command + ' > reply\ncat reply\n')
    wrapper.chmod(0o700)
    if host == 'codex':
        args = [CODEX, 'exec', '--ignore-user-config', '--ephemeral', '--json',
                '--skip-git-repo-check', '--sandbox', 'workspace-write',
                '-c', 'mcp_servers.contactsheet.command=' + json.dumps(NODE),
                '-c', 'mcp_servers.contactsheet.args=' + json.dumps(server_args),
                '-c', 'mcp_servers.contactsheet.enabled_tools=["context_search","context_read"]',
                '-c', 'mcp_servers.contactsheet.tools.context_search.approval_mode="approve"',
                '-c', 'mcp_servers.contactsheet.tools.context_read.approval_mode="approve"', PROMPT]
    else:
        mcp = {'mcpServers': {'contactsheet': {'command': NODE, 'args': server_args}}}
        args = ['claude', '-p', '--verbose', '--output-format', 'stream-json',
                '--settings', '{"disableAllHooks":true}', '--strict-mcp-config',
                '--mcp-config', json.dumps(mcp), '--tools', 'Bash', '--allowedTools',
                'Bash(./read-fixture)', 'mcp__contactsheet__context_search',
                'mcp__contactsheet__context_read', '--', PROMPT]
    start = time.monotonic()
    with (cwd / 'events.jsonl').open('w') as out, (cwd / 'stderr.log').open('w') as err:
        try:
            code = subprocess.run(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out,
                                  stderr=err, timeout=240).returncode
        except subprocess.TimeoutExpired:
            code = 'timeout'
    seconds = round(time.monotonic() - start, 2)
    answer, tools, usage, failures = '', [], {}, []
    for line in (cwd / 'events.jsonl').read_text().splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        kind = event.get('type')
        if host == 'codex':
            item = event.get('item', {})
            if kind == 'item.completed':
                if item.get('type') == 'agent_message':
                    answer = item.get('text', '')
                elif item.get('type') == 'command_execution':
                    tools.append('shell' if item.get('command','').endswith('./read-fixture') or
                                 item.get('command','').endswith("'./read-fixture'") else 'other-shell')
                elif item.get('type') == 'mcp_tool_call':
                    if item.get('status') != 'completed' or item.get('error') or (item.get('result') or {}).get('isError'):
                        failures.append({'tool': item.get('tool'), 'error': item.get('error') or 'MCP tool failed'})
                    tools.append(item.get('tool','') if item.get('server') == 'contactsheet' else 'other-mcp')
            if kind == 'turn.completed':
                usage = event.get('usage') or {}
        elif kind == 'assistant':
            for b in event.get('message', {}).get('content', []):
                if b.get('type') == 'tool_use':
                    name = b['name']
                    if name == 'Bash' and b.get('input', {}).get('command','').strip() == './read-fixture':
                        name = 'shell'
                    tools.append(name.removeprefix('mcp__contactsheet__'))
        elif kind == 'user':
            for b in event.get('message', {}).get('content', []):
                if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('is_error'):
                    failures.append({'tool_use_id': b.get('tool_use_id'), 'error': 'tool failed'})
        elif kind == 'result':
            usage, answer = event.get('usage') or {}, event.get('result', '')
    expected = ['shell'] if mode == 'raw' else ['shell', 'context_search', 'context_read']
    calls = cwd / 'calls'
    exact = answer.strip() == ERROR + '\n' + shipment
    # Count retries in the totals, but require successful execution and the requested path.
    path_ok = (calls.exists() and calls.read_text() == 'x' and
               list(dict.fromkeys(tools)) == expected)
    tokens = usage.get('input_tokens')
    if host == 'claude' and tokens is not None:
        tokens += usage.get('cache_creation_input_tokens', 0) + usage.get('cache_read_input_tokens', 0)
    return dict(mode=mode, exit=code, exact=exact, accepted=code == 0 and exact and path_ok and not failures and bool(tokens),
                tools=tools, failures=failures, input_tokens=tokens, output_tokens=usage.get('output_tokens'), seconds=seconds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='local fixture check only')
    parser.add_argument('--client', choices=['both','codex','claude'], default='both')
    args = parser.parse_args()
    if not NODE or not CLI.is_file():
        parser.error('Install Node and run pnpm build from the ContactSheet checkout first')
    hosts = ['codex', 'claude'] if args.client == 'both' else [args.client]
    if not args.check and any(not (CODEX if h == 'codex' else shutil.which(h)) for h in hosts):
        parser.error('Missing client executable on PATH; run with --client for a single client')
    folder = Path(tempfile.mkdtemp(prefix='contactsheet-retrieval-'))
    print('Results:', folder, flush=True)
    samples = [fixture() for _ in range(3)]
    for shipment, log in samples:
        preflight(folder, log, shipment)
    print('All three previews omit the clue; all three archived clues are retrievable.', flush=True)
    if args.check:
        return
    for host in hosts:
        rows, savings, times = [], [], []
        for n, (shipment, log) in enumerate(samples, 1):
            pair = {}
            for mode in (['raw','capture'] if n % 2 else ['capture','raw']):
                result = run(host, mode, folder / f'{host}-{n}-{mode}', log, shipment)
                rows.append(dict(pair=n, **result))
                pair[mode] = result
                print(host, n, json.dumps(result), flush=True)
                (folder / f'{host}-summary.json').write_text(json.dumps(rows, indent=2))
            if all(run_result['accepted'] for run_result in pair.values()):
                savings.append(100 * (1 - pair['capture']['input_tokens'] / pair['raw']['input_tokens']))
                times.append(pair['capture']['seconds'] - pair['raw']['seconds'])
        for mode in ['raw','capture']:
            print(host, mode, 'exact answers:', sum(r['exact'] for r in rows if r['mode']==mode), '/ 3')
        print(host, 'accepted pairs:', len(savings), '/ 3')
        if savings:
            print(host, 'median input tokens saved: %.2f%%; median extra seconds: %+.2f' %
                  (statistics.median(savings), statistics.median(times)))


if __name__ == '__main__':
    main()
