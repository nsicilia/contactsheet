# Architecture

The CLI opens one database and passes its archive adapter to a shared `ContextEngine`. Local CLI commands call the engine directly. The MCP server accepts a configured engine through its constructor function. Both paths return the same IDs, previews, hits and read cursors.

```text
CLI index / search / read ──┐
                            ├── ContextEngine ── Archive interface ── SqliteArchive
MCP client ── stdio tools ──┘
```

| Workspace | Responsibility |
| --- | --- |
| `packages/core` | Public engine, archive contract, hashing, input bounds and deterministic compression |
| `packages/storage` | SQLite schema versioning, transactional writes, BM25 retrieval and exact paged reads |
| `packages/mcp` | Official MCP SDK stdio transport, argument schemas and archive and coding tools |
| `apps/cli` | Project-local bootstrap, agent hooks, shell output capture and server launch |

## From capture to retrieval

1. **Capture.** Accept well-formed UTF-8 text up to 8 MiB and 100,000 lines per entry. The CLI decodes strictly, retaining an initial BOM. Split on CRLF, LF or CR and keep each separator with its line. Empty input has zero lines.
2. **Archive.** SHA-256 identifies the content. A second hash over content hash, source and session identifies the receipt. Distinct receipts can point to the same original bytes. One SQLite transaction inserts the document, exact line BLOBs, external-content FTS5 index rows and receipt. Writers acquire a reserved lock before checking for duplicates. The database waits up to five seconds for a lock.
3. **Preview.** Pass short logs through verbatim. For larger logs select up to five failure or exception lines first, then the final line, summary candidates and the opening line as space permits. Show line numbers in original order and clip long excerpts. The preview budget is 1,200 UTF-16 code units. Receipt metadata and JSON escaping add overhead. Token usage depends on the model.
4. **Search.** Convert plain query words into quoted FTS terms joined with AND. All words must match the same line. FTS5 ranks by BM25, with ID and line number breaking ties. Search defaults to ten results and accepts an optional entry ID.
5. **Read.** Read contiguous original lines, starting at line one by default. A page covers up to the requested line count (default 20) and 8,192 UTF-16 code units. A long line can span pages. Pass both fields of `next` back unchanged to continue. Concatenating page text preserves the original UTF-8 bytes, line endings and Unicode characters.

The database’s application ID and schema version identify the format. The storage adapter initializes an empty database and rejects unrecognized or future formats. Sessions are provenance labels. The configured database path defines the project boundary.

## Agent capture

For a supported build or test, a pre-execution hook rewrites the shell command. Claude Code and Codex use `PreToolUse` for Bash. Gemini CLI uses `BeforeTool` for `run_shell_command` and reads the override from `hookSpecificOutput.tool_input`. The shell runs the original command in a subshell with `pipefail` and pipes its combined output into the CLI capture process. The hook itself only classifies input. It never starts the build. Its output preserves other tool arguments, and the rewritten command falls outside the matcher on a second pass.

The filter spools to a private file next to the configured project database. Small outputs are replayed as bytes. Larger valid text uses the same engine and archive as explicit indexing. Once a receipt is available the temporary file is removed. A raw-file reference preserves output that exceeds the archive's limits or cannot be indexed. The absolute database path in the generated hook configuration keeps retrieval consistent across working directories.

## Model gateway (Phase 3)

Each listener serves one explicitly selected provider. OpenAI uses POST /v1/responses and /v1/responses/input_tokens. Anthropic uses POST /v1/messages and /v1/messages/count_tokens. These adapters pass provider authentication, Anthropic version and beta headers, and supported input fields to the counter. The default adapter accepts Gemini Developer API v1 and v1beta `generateContent`, `streamGenerateContent` and `countTokens` requests. It forwards per-request authentication to a fixed upstream origin. Clients retain ownership of conversation history. The gateway uses the same archive and content-derived IDs as the CLI and MCP server, so repeated requests can recover the same original turn.

Generation admission uses the provider’s full-request counter. If over budget, the proxy archives large (at least 512 serialized UTF-8 bytes) historical model turns consisting exclusively of text parts. The stored representation is JSON for the complete turn. The last user prompt and everything after it are protected. The proxy performs at most two count calls per generation. It declines over-budget requests when the remaining context cannot fit. This budget applies to provider-counted input and reserves no output tokens.

Responses stream with backpressure. The gateway forwards the provider’s usage metadata, including cache counters when supplied. Local logs contain counts, duration and status. The gateway accepts request bodies up to 8 MiB and limits upstream work to five minutes. It supports SDK and CLI clients on the same machine; browser clients and public multi-user hosting are outside this implementation.

## Dependencies

Node’s bundled SQLite provides the database driver and FTS5. The MCP boundary uses the official TypeScript SDK and Zod. The core has no third-party runtime dependencies. The project uses Node’s built-in test runner.

[SQLite FTS5 reference](https://www.sqlite.org/fts5.html) · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
