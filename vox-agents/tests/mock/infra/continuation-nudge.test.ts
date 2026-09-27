/**
 * Mock-tier tests for the shared `continuationNudge` mechanism (VoxAgent + overrides).
 *
 * The base `VoxAgent.continuationNudge` derives a default finalize-reminder from an agent's
 * `completionTools`, intersected with the active tools VoxContext resolves after prepareStep. Any
 * agent that declares completion tools is nudged only toward the ones available on the current step.
 * Oracle inherits this behavior so replay continuations receive the same finalize reminder.
 *
 * These cover the wording produced for a given tool set; that the resolved set is what reaches the
 * hook, and that the reminder is appended once, are covered in context/vox-context-execute-runs.
 *
 * Each expectation composes the wording through `buildCompletionToolsNudge` rather than repeating
 * it, so the reminder's prose can be edited in one place.
 *
 * Loaded through the agent-registry (the canonical entry) to avoid the circular-import hazard of
 * importing agent modules in isolation.
 */

import { describe, expect, it } from 'vitest';
import '../../../src/infra/agent-registry.js';
import { agentRegistry } from '../../../src/infra/agent-registry.js';
import { buildCompletionToolsNudge } from '../../../src/utils/tools/tool-names.js';
import { createFakeVoxContext } from '../../helpers/fake-vox-context.js';

describe('continuationNudge', () => {
  it('derives the default nudge from completionTools (negotiator, inherited)', () => {
    const negotiator = agentRegistry.get('negotiator') as any;
    expect(negotiator.continuationNudge({}, ['accept-deal', 'propose-deal', 'reject-deal'])).toBe(
      buildCompletionToolsNudge(['accept-deal', 'propose-deal', 'reject-deal'])
    );
  });

  it('derives the strategist nudge from the tools active for its current mode', () => {
    const strategist = agentRegistry.get('simple-strategist') as any;
    expect(strategist.continuationNudge(
      { mode: 'Strategy' },
      ['set-strategy', 'set-persona', 'keep-status-quo'],
    )).toBe(
      buildCompletionToolsNudge(['set-strategy', 'keep-status-quo'])
    );
    expect(strategist.continuationNudge(
      { mode: 'Flavor' },
      ['set-flavors', 'set-persona', 'keep-status-quo'],
    )).toBe(
      buildCompletionToolsNudge(['set-flavors', 'keep-status-quo'])
    );
    expect(strategist.continuationNudge(
      { mode: 'Strategy' },
      ['set-persona', 'keep-status-quo'],
    )).toBe(
      buildCompletionToolsNudge(['keep-status-quo'])
    );
  });

  it('derives the Oracle nudge from the completion tools active in the replay', () => {
    const oracle = agentRegistry.get('oracle') as any;
    expect(oracle.continuationNudge({}, ['set-strategy', 'get-briefing', 'keep-status-quo'])).toBe(
      buildCompletionToolsNudge(['set-strategy', 'keep-status-quo'])
    );
    expect(oracle.continuationNudge({}, ['get-briefing'])).toBeUndefined();
  });

  it('nudges a live envoy toward its own completion tools in normal mode (diplomat)', () => {
    const diplomat = agentRegistry.get('diplomat') as any;
    expect(diplomat.continuationNudge(
      {},
      ['get-briefing', 'send-message', 'call-negotiator', 'close-conversation'],
    )).toBe(
      buildCompletionToolsNudge(['send-message', 'call-negotiator', 'close-conversation'])
    );
  });

  it('nudges a live envoy only toward the completion tools resolved for this step', () => {
    const diplomat = agentRegistry.get('diplomat') as any;
    const nudge = diplomat.continuationNudge({}, ['send-message']);
    expect(nudge).toBe(buildCompletionToolsNudge(['send-message']));
    expect(nudge).not.toContain('call-negotiator');
    expect(nudge).not.toContain('close-conversation');

    expect(diplomat.continuationNudge(
      {},
      ['call-negotiator', 'send-message'],
    )).toBe(
      buildCompletionToolsNudge(['send-message', 'call-negotiator'])
    );
  });

  it('omits the nudge when the resolved step exposes no completion tool', () => {
    const diplomat = agentRegistry.get('diplomat') as any;
    expect(diplomat.continuationNudge({}, ['get-briefing'])).toBeUndefined();
  });
});