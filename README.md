# ContactSheet

Archive a command’s complete output on your machine and give a coding agent a short preview. The agent can search for a failure and read the original lines from the same SQLite file. ContactSheet runs from a checkout with Node.js 24.12+ (24.x, with FTS5) and pnpm 10.13.1.

## Run it

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm --silent contactsheet init
```

The test command builds all four TypeScript packages. For a build on its own, run `pnpm build`. The idempotent `init` command creates `.context/archive.sqlite` and prints an MCP launch configuration with absolute paths. Use `--db PATH` on any command or set `CONTEXT_DB` to choose another archive.

```sh
printf 'PASS cache\nERROR checkout timed out\n' | pnpm --silent contactsheet index --source checkout
pnpm --silent contactsheet search 'checkout timed out'
```

Copy the returned `id` into the following command to read the matching line:

```sh
pnpm --silent contactsheet read <archive-id> --line 2 --count 1
```

Replace `<archive-id>` with the actual value. For an existing file, use `pnpm --silent contactsheet index build.log`. For large command results, pipe output directly into the CLI so the agent only sees the receipt. For example, in Bash or Zsh:

```sh
set -o pipefail
pnpm test 2>&1 | pnpm --silent contactsheet index --source 'pnpm test' --session local
```

The receipt includes the full content’s SHA-256, source, session label, timestamp, byte count, line count and preview. Identical content and labels return the original receipt.

## Connect an agent

For clients that accept JSON `mcpServers` settings, copy the entry printed by `pnpm --silent contactsheet init` into the client’s configuration. To register the default project archive with Codex CLI, run this from the repository root:

```sh
codex mcp add contactsheet -- "$(command -v node)" "$PWD/apps/cli/dist/index.js" serve --db "$PWD/.context/archive.sqlite"
```

Open a session with the server enabled. An example request is “Search the local archive for ‘checkout timed out’, then read the matching line and the next two lines.”

| Tool | Inputs | Result |
| --- | --- | --- |
| `context_index` | `text`, optional `source` and `session` | Receipt with the archive ID and preview |
| `context_search` | `query`, optional `id` and `limit` (1–50) | Ranked hits with ID, source, 1-based line and excerpt |
| `context_read` | `id`, optional `line`, `count` (1–200) and `offset` | Exact text and a `next` cursor, or `null` at end |

Indexing through MCP takes literal text. To keep a large log out of the conversation from the beginning, use file or stdin ingestion through the CLI. All clients pointed at a database can access its contents. Use a separate archive file for each project you want to isolate. The archive holds plaintext and the project-local default is gitignored.

## Automatic build and test capture

Claude Code, Codex CLI, and Gemini CLI can capture selected foreground commands before the result reaches the conversation. Ask the agent to run a build or test normally. Output through 4,096 bytes passes back verbatim. For a larger text log, the agent gets a preview and an ID for `context_search` and `context_read`. Both the hook and the MCP server must point at the same database.

From the project you want to use with the agent, set `cli` to the absolute path of the built ContactSheet CLI. If you are working in the ContactSheet checkout itself, run:

```sh
cli="$PWD/apps/cli/dist/index.js"
```

**Claude Code.** Launch one session with the hook and the archive tools:

```sh
claude --settings "$(node "$cli" hook-config claude)" --mcp-config "$(node "$cli" init)"
```

For persistent project setup, merge the generated hook group into `.claude/settings.local.json` and the MCP entry into `.mcp.json`. Choose one registration method per project.

**Codex CLI.** For a project with no existing hooks file, create it with the following commands. The subshell protects an existing file from being overwritten.

```sh
mkdir -p .codex
(set -C; node "$cli" hook-config codex > .codex/hooks.json)
```

If the file already exists, run `node "$cli" hook-config codex` and append the generated group to its `hooks.PreToolUse` array. Register the archive in the same project's `.codex/config.toml` under `[mcp_servers.contactsheet]`, using the `command` and `args` from `node "$cli" init`. An existing registration for the same archive also works. Open Codex in the trusted project and review the hook in `/hooks`. A new session picks up the configuration.

**Gemini CLI.** From the target project, generate its workspace settings using the built CLI path set above. This includes both the `BeforeTool` hook for `run_shell_command` and the ContactSheet MCP server. Both use the same absolute archive path.

```sh
mkdir -p .gemini
(set -C; node "$cli" hook-config gemini > .gemini/settings.json)
```

If settings already exist, print the configuration with `node "$cli" hook-config gemini`, append the generated group to `hooks.BeforeTool`, and merge `mcpServers.contactsheet`. Start Gemini CLI in the trusted workspace and check the hook with `/hooks panel` and the archive tools with `/mcp`. Ask Gemini to run a test and search the captured log for a diagnostic. Gemini applies its command permissions to the resulting capture pipeline. In headless sessions the applicable policy must permit that pipeline, including output redirection. Background shell calls follow Gemini’s ordinary execution path.

**Coverage.** The adapters target Bash and Zsh on macOS and Linux. Supported examples include `npm test`, `pnpm run build`, `yarn lint`, `bun test`, `node --test`, `pytest`, `go test ./...`, `cargo build`, and `make check`. The matcher accepts simple words and options. Compound commands, quoted shell expressions, pipelines, and explicit watch/background modes use the host's normal execution path. To capture a compound command explicitly, use the CLI pipe in **Run it**.

**Storage and output.** The shell combines stdout and stderr in write order. ContactSheet returns the result when the command finishes. Outputs over 8 MiB, logs over 100,000 lines, undecodable large outputs, and indexing failures return a path to a private raw file beside the database. Keep that file for exact recovery or remove it when finished. The capture hook preserves the build's exit status when returning either a receipt or a raw-file path.

[Claude Code hook reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) · [Codex hook reference](https://learn.chatgpt.com/docs/hooks) · [Gemini CLI hook reference](https://geminicli.com/docs/hooks/reference/)

## Verification

`pnpm test` exercises the core, SQLite and the CLI. The integration test starts the compiled stdio server with the official MCP client, indexes a generated 3,001-line log, checks all five failures in the preview, searches for one failure, and reconstructs the entire input through paged reads. It also checks that CLI and MCP return the same receipt. Capture tests invoke all three generated hook commands, execute their rewritten shell commands against a failing build, verify exactly one execution and exit status 23, then retrieve an omitted diagnostic and reconstruct the output through MCP.

[Architecture and limits](ARCHITECTURE.md) · [MIT license](LICENSE)
