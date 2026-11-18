# ContactSheet

Archive a command’s complete output on your machine and give a coding agent a short preview. The agent can search for a failure and read the original lines from the same SQLite file. Phase 1 runs from a checkout with Node.js 24.12+ (24.x, with FTS5) and pnpm 10.13.1.

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

## Verification

`pnpm test` exercises the core, SQLite and the CLI. The integration test starts the compiled stdio server with the official MCP client, indexes a generated 3,001-line log, checks all five failures in the preview, searches for one failure, and reconstructs the entire input through paged reads. It also checks that CLI and MCP return the same receipt.

[Architecture and limits](ARCHITECTURE.md) · [MIT license](LICENSE)
