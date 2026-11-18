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
| `packages/mcp` | Official MCP SDK stdio transport, argument schemas and three tools |
| `apps/cli` | Project-local bootstrap, agent hooks, shell output capture and server launch |

## From capture to retrieval

1. **Capture.** Accept well-formed UTF-8 text up to 8 MiB and 100,000 lines per entry. The CLI decodes strictly, retaining an initial BOM. Split on CRLF, LF or CR and keep each separator with its line. Empty input has zero lines.
2. **Archive.** SHA-256 identifies the content. A second hash over content hash, source and session identifies the receipt. Distinct receipts can point to the same original bytes. One SQLite transaction inserts the document, exact line BLOBs, external-content FTS5 index rows and receipt. Writers acquire a reserved lock before checking for duplicates. The database waits up to five seconds for a lock.
3. **Preview.** Pass short logs through verbatim. For larger logs select up to five failure or exception lines first, then the final line, summary candidates and the opening line as space permits. Show line numbers in original order and clip long excerpts. The preview budget is 1,200 UTF-16 code units. Receipt metadata and JSON escaping add overhead. Token usage depends on the model.
4. **Search.** Convert plain query words into quoted FTS terms joined with AND. All words must match the same line. FTS5 ranks by BM25, with ID and line number breaking ties. Search defaults to ten results and accepts an optional entry ID.
5. **Read.** Read contiguous original lines, starting at line one by default. A page covers up to the requested line count (default 20) and 8,192 UTF-16 code units. A long line can span pages. Pass both fields of `next` back unchanged to continue. Concatenating page text preserves the original UTF-8 bytes, line endings and Unicode characters.

The database’s application ID and schema version identify the format. The storage adapter initializes an empty database and rejects unrecognized or future formats. Sessions are provenance labels. The configured database path defines the project boundary.

## Agent capture

For a supported build or test, a `PreToolUse` hook returns modified Bash input. The shell runs the original command in a subshell with `pipefail` and pipes its combined output into the CLI capture process. The hook itself only classifies input. It never starts the build. Its output preserves other tool arguments, and the rewritten command falls outside the matcher on a second pass.

The filter spools to a private file next to the configured project database. Small outputs are replayed as bytes. Larger valid text uses the same engine and archive as explicit indexing. Once a receipt is available the temporary file is removed. A raw-file reference preserves output that exceeds the archive's limits or cannot be indexed. The absolute database path in the generated hook configuration keeps retrieval consistent across working directories.

## Gateway extension point

A future model-request proxy can construct the same `ContextEngine` and archive provider payloads through its public API. Provider adapters, streaming, conversation budgets and prompt-cache behavior belong in that application. The current executable serves local tools over stdio. Capture is available through the CLI, MCP, and the two local agent adapters. The provider proxy is a later milestone.

## Dependencies

Node’s bundled SQLite provides the database driver and FTS5. The MCP boundary uses the official TypeScript SDK and Zod. The core has no third-party runtime dependencies. The project uses Node’s built-in test runner.

[SQLite FTS5 reference](https://www.sqlite.org/fts5.html) · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
