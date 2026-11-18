// These instructions are also delivered to clients that only speak MCP.
export const levels = {
  lite: 'Use nearby code and existing dependencies first. Keep edits focused. Explain the result and how you verified it.',
  full: 'Trace the caller, stored data and failure paths before editing. Prefer an existing API or a direct implementation. Preserve validation, accessibility and security. Exercise the changed behavior, including retries or partial failure where applicable. Explain any remaining limit and record a deliberate deferral with a shortcut: comment and a concrete revisit condition.',
  ultra: 'First check whether configuration, deletion or an existing feature already solves the request. Deliver the smallest complete implementation. Require a present caller for each new abstraction or dependency. Verify the real entry point, compatibility and failure handling. Report the result, verification and any deliberate deferral briefly.',
  off: '',
} as const;

export const workflows = {
  review: 'Review the requested diff. Default to staged and unstaged changes plus relevant new files. Honor a staged, branch or PR target. Inspect affected callers, tests and data formats. For each reproducible risk give severity, file and line, triggering input, consequence and a specific correction. Report coverage gaps separately. Leave files untouched.',
  audit: 'Inspect the repository without edits. Start with entry points, persistence, trust boundaries and expensive operations. Follow evidence into callers and tests. Rank concrete correctness, security, performance and maintenance findings by impact and likelihood. Give the location, triggering conditions and smallest repair for each.',
  debt: 'Search tracked and nonignored working files for comments marked shortcut: or a marker supplied by the user. Exclude dependencies, generated files, documentation examples and strings that are not code comments. List path and line, deferred work and the recorded revisit condition. Flag absent conditions. Leave files untouched.',
  gain: 'Compare two observed runs of the same task, baseline and guided, with the same inputs, model and acceptance checks. Report changed lines, billed tokens, elapsed time and cost only where measured. Use contactsheet compare with the two JSON measurements. Disclose failed checks, missing data and differences in conditions. If no pair exists, explain what measurements are needed.',
  help: 'Set the archive coding mode to lite, full, ultra or off using context_coding with level. Ask for review, audit, debt or gain using its action parameter. Use the CLI coding command for the same controls. Claude Code also supports the optional session board.',
} as const;

export function codingPolicy(level: string, action?: string) {
  if (!Object.hasOwn(levels, level)) throw new Error('Expected coding level: lite, full, ultra or off');
  if (action && !Object.hasOwn(workflows, action)) throw new Error('Expected review, audit, debt, gain or help');
  return { level, instructions: levels[level as keyof typeof levels],
    ...(action ? { workflow: workflows[action as keyof typeof workflows] } : {}) };
}
