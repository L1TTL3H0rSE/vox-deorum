/**
 * Mock-tier tests for the shared `continuationNudge` mechanism (VoxAgent + overrides).
 *
 * The base `VoxAgent.continuationNudge` builds the step's closing reminder. From the second step on
 * it nudges toward the agent's `completionTools`, intersected with the tools VoxContext resolves as
 * executable after prepareStep, so an agent is nudged only toward the ones it may call on the current
 * step. When the step is narrowed, it also names the allowed tools, and when its tool choice is
 * required, it opens with the requirement.
 * Oracle inherits this behavior so replay continuations receive the same finalize reminder.
 *
 * These cover the wording produced for a given tool set; that the resolved set is what reaches the
 * hook, and that the reminder is appended once, are covered in context/vox-context-execute-runs.
 *
 * Each expectation composes the wording through the tool-names builders rather than repeating it,
 * so the reminder's prose can be edited in one place.
 *
 * Loaded through the agent-registry (the canonical entry) to avoid the circular-import hazard of
 * importing agent modules in isolation.
 */

import { describe, expect, it } from 'vitest';
import '../../../src/infra/agent-registry.js';
import { agentRegistry } from '../../../src/infra/agent-registry.js';
import {
  buildCompletionToolsNudge,
  buildToolPolicyReminder,
  buildToolRequirementReminder,
} from '../../../src/utils/tools/tool-names.js';

/** A later, unnarrowed step with an auto tool choice that may run `executable`. */
function later(executable: string[]) {
  return { executable, narrowed: false, step: 1, required: false };
}

describe('continuationNudge', () => {
  it('derives the default nudge from completionTools (negotiator, inherited)', () => {
    const negotiator = agentRegistry.get('negotiator') as any;
    expect(negotiator.continuationNudge({}, later(['accept-deal', 'propose-deal', 'reject-deal']))).toBe(
      buildCompletionToolsNudge(['accept-deal', 'propose-deal', 'reject-deal'])
    );
  });

  it('derives the strategist nudge from the tools active for its current mode', () => {
    const strategist = agentRegistry.get('simple-strategist') as any;
    expect(strategist.continuationNudge(
      { mode: 'Strategy' },
      later(['set-strategy', 'set-persona', 'keep-status-quo']),
    )).toBe(
      buildCompletionToolsNudge(['set-strategy', 'keep-status-quo'])
    );
    expect(strategist.continuationNudge(
      { mode: 'Flavor' },
      later(['set-flavors', 'set-persona', 'keep-status-quo']),
    )).toBe(
      buildCompletionToolsNudge(['set-flavors', 'keep-status-quo'])
    );
    expect(strategist.continuationNudge(
      { mode: 'Strategy' },
      later(['set-persona', 'keep-status-quo']),
    )).toBe(
      buildCompletionToolsNudge(['keep-status-quo'])
    );
  });

  it('derives the Oracle nudge from the completion tools active in the replay', () => {
    const oracle = agentRegistry.get('oracle') as any;
    expect(oracle.continuationNudge({}, later(['set-strategy', 'get-briefing', 'keep-status-quo']))).toBe(
      buildCompletionToolsNudge(['set-strategy', 'keep-status-quo'])
    );
    expect(oracle.continuationNudge({}, later(['get-briefing']))).toBeUndefined();
  });

  it('nudges a live envoy toward its own completion tools in normal mode (diplomat)', () => {
    const diplomat = agentRegistry.get('diplomat') as any;
    expect(diplomat.continuationNudge(
      {},
      later(['get-briefing', 'send-message', 'call-negotiator', 'close-conversation']),
    )).toBe(
      buildCompletionToolsNudge(['send-message', 'call-negotiator', 'close-conversation'])
    );
  });

  it('nudges a live envoy only toward the completion tools resolved for this step', () => {
    const diplomat = agentRegistry.get('diplomat') as any;
    const nudge = diplomat.continuationNudge({}, later(['send-message']));
    expect(nudge).toBe(buildCompletionToolsNudge(['send-message']));
    expect(nudge).not.toContain('call-negotiator');
    expect(nudge).not.toContain('close-conversation');

    expect(diplomat.continuationNudge(
      {},
      later(['call-negotiator', 'send-message']),
    )).toBe(
      buildCompletionToolsNudge(['send-message', 'call-negotiator'])
    );
  });

  it('omits the nudge when the resolved step exposes no completion tool', () => {
    const diplomat = agentRegistry.get('diplomat') as any;
    expect(diplomat.continuationNudge({}, later(['get-briefing']))).toBeUndefined();
  });

  describe('closing reminder', () => {
    const diplomat = () => agentRegistry.get('diplomat') as any;
    const gated = ['call-negotiator', 'send-message'];
    const nudge = () => buildCompletionToolsNudge(['send-message', 'call-negotiator'])!;

    it('adds nothing on an unnarrowed auto first step', () => {
      expect(diplomat().continuationNudge({}, { executable: gated, narrowed: false, step: 0, required: false }))
        .toBeUndefined();
    });

    it('states only the requirement on an unnarrowed required first step', () => {
      expect(diplomat().continuationNudge({}, { executable: gated, narrowed: false, step: 0, required: true }))
        .toBe(buildToolRequirementReminder());
    });

    it('states only the tool policy on a narrowed auto first step', () => {
      expect(diplomat().continuationNudge({}, { executable: gated, narrowed: true, step: 0, required: false }))
        .toBe(buildToolPolicyReminder(gated));
    });

    it('orders the requirement, the policy, and the finalize nudge in one reminder', () => {
      const reminder: string = diplomat().continuationNudge({}, { executable: gated, narrowed: true, step: 1, required: true });
      const requirementAt = reminder.indexOf(buildToolRequirementReminder());
      const policyAt = reminder.indexOf(buildToolPolicyReminder(gated));
      expect(requirementAt).toBe(0);
      expect(policyAt).toBeGreaterThan(requirementAt);
      expect(reminder.indexOf(nudge())).toBeGreaterThan(policyAt);
    });

    it('states that no tool may run, without the requirement, when the step allows none', () => {
      // The loop drops a step with nothing to run to auto, so the requirement never meets this policy.
      const reminder = diplomat().continuationNudge({}, { executable: [], narrowed: true, step: 0, required: false });
      expect(reminder).toBe(buildToolPolicyReminder([]));
      expect(reminder).not.toContain('send-message');
    });
  });
});
