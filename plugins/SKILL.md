---
name: contactsheet
description: Find failures in locally archived build and test output and recover exact original lines.
---

Use `context_search` with a distinctive term to locate an archived diagnostic. When a command returns an archive ID, pass that ID to limit the search. Use `context_read` with the matching ID and line number to read the original text. Follow the returned cursor for more. Use `context_index` to archive supplied text. The tools may have a host-specific server prefix.

For large output in a host without automatic capture, pipe the command into ContactSheet's CLI or index the saved file before reading it into the conversation.
