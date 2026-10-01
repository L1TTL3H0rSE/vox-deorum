/**
 * @module utils/models/cache-breakpoint
 *
 * The Anthropic prompt-cache breakpoint marker shared by every agent prompt.
 */

/**
 * The breakpoint marker itself. Honored by the direct Anthropic provider, OpenRouter (whose
 * provider falls back to the `anthropic` key) and Vertex Anthropic; ignored by other providers.
 * Spread into a message's `providerOptions` to mark the end of a cacheable prefix. Entries live for
 * one hour so a prefix written early in a game turn survives the rest of that turn's agent runs.
 */
export const cacheBreakpoint = { anthropic: { cacheControl: { type: "ephemeral" as const, ttl: "5m" as const } } };
