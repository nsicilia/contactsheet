---
name: contactsheet
description: Implement and review code with the current ContactSheet policy, audit repositories, track deferred work, compare measurements and retrieve archived build output.
---

Use `context_search` with a distinctive term to locate an archived diagnostic. When a command returns an archive ID, pass that ID to limit the search. Use `context_read` with the matching ID and line number to read the original text. Follow the returned cursor for more. Use `context_index` to archive supplied text. The tools may have a host-specific server prefix.

For large output in a host without automatic capture, pipe the command into ContactSheet's CLI or index the saved file before reading it into the conversation.

When asked to remember a project decision, record it with `context_decision_save` and cite an archive ID and line. Use `context_decision_list` to discover keys and `context_decision_read` to retrieve the current decision or a specific revision. Read the current revision before revising it. Use `context_read` to verify the cited evidence.

For coding tasks request the current policy from `context_coding` and apply it throughout the task. A request to change intensity or disable coding guidance sets its level. For a change review, repository audit, shortcut ledger or benchmark comparison, request the corresponding action (review, audit, debt or gain) and carry out the returned workflow using the host's tools. The archive tools remain available at every level.
