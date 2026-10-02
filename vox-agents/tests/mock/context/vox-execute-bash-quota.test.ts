/**
 * Tests for the files quota in the agent execution loop (src/infra/vox-execute.ts): the quota limits
 * the model steps that may run bash in one execution. Parallel bash calls in one step all run, and
 * later steps get a failure without running a command. Same mocking idiom as vox-execute.test.ts,
 * except the mocked step runs its bash calls through the registered tool, as the AI SDK would.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/models/models.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/utils/models/models.js')>();
  return { ...actual, getModel: vi.fn(() => ({} as any)), buildProviderOptions: vi.fn(() => ({})) };
});
vi.mock('../../../src/utils/models/concurrency.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/utils/models/concurrency.js')>();
  return { ...actual, streamTextWithConcurrency: vi.fn() };
});

import { VoxContext } from '../../../src/infra/vox-context.js';
import { VoxAgent } from '../../../src/infra/vox-agent.js';
import { agentRegistry } from '../../../src/infra/agent-registry.js';
import { streamTextWithConcurrency } from '../../../src/utils/models/concurrency.js';
import { bashToolName } from '../../../src/utils/tools/bash-tool.js';
import { PlayerWorkspace } from '../../../src/utils/workspace/player-workspace.js';
import type { StrategistParameters } from '../../../src/strategist/strategy-parameters.js';
import { makeStrategistParameters } from '../../helpers/fake-vox-context.js';
import type { Model } from '../../../src/types/index.js';

const stc = vi.mocked(streamTextWithConcurrency);

/** An agent that runs a fixed number of steps with all registered tools. */
class BashStepAgent extends VoxAgent<StrategistParameters> {
  readonly description = 'bash quota test agent';
  constructor(public readonly name: string, private readonly steps: number) { super(); }
  /** Selects a mocked model so no provider is contacted. */
  override getModel(): Model { return { provider: 'test', name: 'test' } as Model; }
  /** Supplies the minimal system prompt required by the execution loop. */
  async getSystem(): Promise<string> { return 'system'; }
  /** Stops after the configured number of steps. */
  override stopCheck(_p: StrategistParameters, _i: unknown, _last: unknown, allSteps: unknown[]): boolean {
    return allSteps.length >= this.steps;
  }
}

/**
 * Script the mocked model: each entry is the number of bash calls in that step. The calls run
 * through the bash tool in parallel, and their results are collected per step.
 */
function scriptSteps(callsPerStep: number[], results: unknown[][]) {
  let step = 0;
  stc.mockImplementation(async (config: any) => {
    const count = callsPerStep[step++] ?? 0;
    const toolCalls = Array.from({ length: count }, (_, index) => ({ toolName: bashToolName, toolCallId: `s${step}-${index}` }));
    results.push(await Promise.all(toolCalls.map((call) =>
      config.tools[bashToolName].execute({ Command: 'true' }, { toolCallId: call.toolCallId, messages: [] }))));
    return {
      steps: [{
        text: '',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        response: { messages: [{ role: 'assistant', content: '' }] },
        toolCalls,
        toolResults: [],
      }],
    } as any;
  });
}

beforeAll(() => {
  agentRegistry.register(new BashStepAgent('bash-quota-agent', 3) as any);
});

beforeEach(() => {
  stc.mockReset();
});

describe('files quota in the step loop', () => {
  it('should run every bash call of a step admitted before the quota and none after', async () => {
    const ctx = new VoxContext<StrategistParameters>({}, 'bash-quota');
    ctx.files = { game: 'write', shared: {}, quota: 1 };
    ctx.registerAgentTools();
    const exec = vi.spyOn(PlayerWorkspace.prototype, 'exec').mockResolvedValue({ stdout: 'ran', stderr: '', exitCode: 0 });
    const results: unknown[][] = [];
    scriptSteps([2, 1, 1], results);

    try {
      await ctx.withRun({ parameters: makeStrategistParameters() }, () => ctx.execute('bash-quota-agent', {}));
      expect(exec).toHaveBeenCalledTimes(2);
      expect(results[0]).toEqual([{ stdout: 'ran', stderr: '', exitCode: 0 }, { stdout: 'ran', stderr: '', exitCode: 0 }]);
      for (const result of [...results[1], ...results[2]]) expect(result).toMatchObject({ stdout: '', exitCode: 1 });
    } finally {
      exec.mockRestore();
    }
  });

  it('should give each execution its own quota', async () => {
    const ctx = new VoxContext<StrategistParameters>({}, 'bash-quota-fresh');
    ctx.files = { game: 'write', shared: {}, quota: 1 };
    ctx.registerAgentTools();
    const exec = vi.spyOn(PlayerWorkspace.prototype, 'exec').mockResolvedValue({ stdout: 'ran', stderr: '', exitCode: 0 });
    const results: unknown[][] = [];
    scriptSteps([1, 0, 0, 1, 0, 0], results);

    try {
      await ctx.withRun({ parameters: makeStrategistParameters() }, async () => {
        await ctx.execute('bash-quota-agent', {});
        await ctx.execute('bash-quota-agent', {});
      });
      expect(exec).toHaveBeenCalledTimes(2);
    } finally {
      exec.mockRestore();
    }
  });
});
