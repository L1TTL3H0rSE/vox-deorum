/**
 * Claude Code model construction and host-tool translation.
 */

import { wrapLanguageModel } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createClaudeCode, type ClaudeCodeSettings } from 'ai-sdk-provider-claude-code';
import type { Model } from '../../../types/index.js';
import {
  claudeCodeResponseMiddleware,
  guardClaudeCodeQueryUsageLimits,
  hideClaudeCodeStructuredOutputResults,
} from './claude-code-response.js';
import { resolveHostToolCapabilities } from './host-tools.js';
import type { HostMetaTool, HostToolCapabilities } from './host-tools.js';

/** Concrete Claude Code tools granted by each host meta-tool. */
export const claudeCodeMetaToolExpansion: Record<HostMetaTool, readonly string[]> = {
  Web: ['WebFetch', 'WebSearch'],
};

/**
 * Expands resolved host capabilities into the concrete Claude Code tool list.
 * TodoWrite bookkeeping rides along whenever any capability is enabled.
 */
export function expandClaudeCodeTools(access: HostToolCapabilities): string[] {
  const tools: string[] = [];
  if (access.web) tools.push(...claudeCodeMetaToolExpansion.Web);
  if (tools.length > 0) tools.push('TodoWrite');
  return tools;
}

/** The constructed Claude Code model and its prompt-mode rebound configuration. */
export interface ClaudeCodeModelBuildResult {
  model: LanguageModelV4;
  config: Model;
}

/**
 * Build a Claude Code model with explicit host-tool permissions and forced
 * prompt-mode game tools, because the provider has no native AI SDK tool calls.
 */
export function buildClaudeCodeModel(modelConfig: Model): ClaudeCodeModelBuildResult {
  const config: Model = {
    ...modelConfig,
    options: { ...modelConfig.options, toolMiddleware: 'prompt' },
  };
  const options = config.options ?? {};
  if (Object.hasOwn(options, 'claudeCodeTools')) {
    throw new Error('The `claudeCodeTools` option was renamed to `hostTools`. Update this model configuration.');
  }

  const settings: ClaudeCodeSettings = {
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    onQueryCreated: (query) => {
      hideClaudeCodeStructuredOutputResults(query);
      guardClaudeCodeQueryUsageLimits(query);
    },
    // The provider forwards every ANTHROPIC_* variable to the Claude Code CLI,
    // which then bills the API key instead of the subscription login. Unset the
    // key so the CLI falls back to its own credentials; Node drops undefined
    // entries from a child's environment.
    env: { ANTHROPIC_API_KEY: undefined },
  };
  const capabilities = resolveHostToolCapabilities(options.hostTools);
  const hostTools = expandClaudeCodeTools(capabilities);

  if (hostTools.length === 0) {
    settings.tools = [];
  } else {
    // Availability is bounded by `tools`; `allowedTools` and dontAsk enforce
    // permissions. Do not set disallowedTools because the provider warns when
    // it is combined with an allowlist.
    settings.tools = hostTools;
    settings.permissionMode = 'dontAsk';
    settings.allowedTools = hostTools;
  }

  if (options.reasoningEffort === 'minimal') {
    settings.thinking = { type: 'disabled' };
  } else if (options.reasoningEffort) {
    settings.effort = options.reasoningEffort;
    settings.thinking = { type: 'adaptive', display: 'summarized' };
  }

  const model = wrapLanguageModel({
    model: createClaudeCode()(config.name, settings),
    middleware: claudeCodeResponseMiddleware(),
  });
  return { model, config };
}
