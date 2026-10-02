/**
 * @module utils/tools/tool-names
 *
 * Formatting helpers for tool-name lists. Deliberately free of agent/registry imports so both the
 * agent loop and provider middleware can share one rendering of "these tools" without the cycle
 * `agents -> models -> providers -> terminal-tools -> agent-registry -> agents` would create.
 */

/** The registered name of the workspace tool, kept here so provider middleware can name it. */
export const bashToolName = 'bash';

/**
 * Formats a name list into a grammatical, backtick-quoted fragment:
 *   1 -> "`a`"   2 -> "`a` or `b`"   N -> "`a`, `b`, or `c`" (Oxford comma).
 * Returns undefined for an empty list.
 */
export function formatToolChoiceList(names: string[]): string | undefined {
  const q = names.map(n => `\`${n}\``);
  if (q.length === 0) return undefined;
  if (q.length === 1) return q[0];
  if (q.length === 2) return `${q[0]} or ${q[1]}`;
  return `${q.slice(0, -1).join(", ")}, or ${q[q.length - 1]}`;
}

/**
 * Builds the default continuation nudge for an agent from its completion tools: a one-sentence
 * reminder to finalize by calling one of them. Returns undefined for an empty list so the
 * injection site skips naturally.
 */
export function buildCompletionToolsNudge(names: string[]): string | undefined {
  const list = formatToolChoiceList(names);
  return list ? `Make sure to call ${list} following the EXACT provided format to finalize your decisions.` : undefined;
}

/**
 * Builds the policy sentence for a step whose tools were narrowed below the agent's declared set.
 * The removed tools stay declared to the model, so this names what may actually run this step.
 */
export function buildToolPolicyReminder(executable: string[]): string {
  const list = formatToolChoiceList(executable);
  return list
    ? `For this step, you may only call ${list}; other tools will return an error.`
    : 'No tools are available for this step. Write response in plain text.';
}

/**
 * Builds the sentence for a step whose tool choice is required. It lives in the closing reminder
 * rather than the provider middleware's system text, so a step that drops to auto (all tools
 * removed) changes only the end of the prompt. "One or more" and "as many as you need" keep it from
 * reading as a cap, since agent prompts encourage batching several calls in one reply.
 */
export function buildToolRequirementReminder(): string {
  return 'IMPORTANT: You must issue tool calls to collect information or make actions, as many as you need. Plain text response goes nowhere.';
}

/**
 * Builds the single closing reminder appended to a step, from up to three sentences in this order:
 * the requirement when the step's tool choice is required, the policy sentence when the step is
 * narrowed, and the finalize nudge toward the allowed completion tools from the second step on.
 * Returns undefined when none applies.
 */
export function buildClosingReminder(
  executable: string[],
  completionTools: string[] | undefined,
  options: { narrowed: boolean; step: number; required: boolean },
): string | undefined {
  const allowed = new Set(executable);
  const sentences = [
    options.required ? buildToolRequirementReminder() : undefined,
    options.narrowed ? buildToolPolicyReminder(executable) : undefined,
    options.step > 0
      ? buildCompletionToolsNudge((completionTools ?? []).filter(name => allowed.has(name)))
      : undefined,
  ].filter((sentence): sentence is string => sentence !== undefined);
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}
