import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ evaluator: vi.fn() }));
vi.mock('../../../src/utils/models/evaluation.js', () => ({ getEvaluatorConfig: mocks.evaluator }));

import { VoxContext } from '../../../src/infra/vox-context.js';
import { strategicRoutingEnabled, routeStrategicTurn } from '../../../src/strategist/strategic-routing.js';
import { makeGameState, makeStrategistParameters } from '../../helpers/fake-vox-context.js';
import type { StrategistParameters } from '../../../src/strategist/strategy-parameters.js';

/** Build one current, provenance-bound player/options snapshot and complete event window. */
function parameters(): StrategistParameters {
  const Source = { GameID: 'routing-game', PlayerID: 1, Turn: 8 };
  return makeStrategistParameters({
    gameID: 'routing-game', playerID: 1, turn: 8, after: 8_000_000, before: 8_999_999, lastDecisionTurn: 5,
    gameStates: { 8: makeGameState(8, {
      players: { '1': { Source, Gold: 50, GoldPerTurn: 5, NextPolicyTurns: 3 } },
      options: {
        Source, Options: { Technologies: ['Writing'], Policies: ['Tradition'] },
        Strategy: { UpdatedTurn: 5, GrandStrategy: 'Culture', EconomicStrategies: [], MilitaryStrategies: [], Rationale: 'old note' },
        Technology: { UpdatedTurn: 5, Next: 'Writing' }, Policy: { UpdatedTurn: 5, Next: 'Tradition' },
      },
      events: {}, eventsAfter: 5_000_000, eventsBefore: 8_999_999,
      eventsPerspective: { gameID: 'routing-game', playerID: 1 },
    }) },
  });
}

/** Open the real VoxContext run required by evaluation and routing. */
async function routed(
  params: StrategistParameters,
  answer: unknown,
  options: { fullRequired?: boolean; triage?: boolean; name?: string; evaluator?: unknown } = {},
) {
  const context = new VoxContext({}, 'strategic-routing-test');
  context.triage = options.triage ?? true;
  context.evaluate = vi.fn(async () => answer as never) as never;
  mocks.evaluator.mockReturnValue(Object.hasOwn(options, 'evaluator') ? options.evaluator : { provider: 'openai', name: 'evaluator-model' });
  try {
    return await context.withRun({ parameters: params }, async () => ({
      result: await routeStrategicTurn(options.name ?? 'simple-strategist', params, context, options.fullRequired ?? false),
      evaluate: context.evaluate as unknown as ReturnType<typeof vi.fn>,
    }));
  } finally {
    await context.shutdown();
  }
}

/** Return one provider-shaped route answer. */
function answer(choice: string) {
  return { answers: { route: { type: 'choice', choice } } };
}

describe('strategic turn routing', () => {
  beforeEach(() => mocks.evaluator.mockReset());

  it('should disable routing for opt-out and non-strategist agents without evaluating', async () => {
    expect(strategicRoutingEnabled('simple-strategist', false)).toBe(false);
    expect(strategicRoutingEnabled('diplomat', true)).toBe(false);
    const params = parameters();
    const result = await routed(params, answer('large'), { triage: false });
    expect(result.result).toMatchObject({ route: 'skip', source: 'fallback', reason: 'disabled' });
    expect(result.evaluate).not.toHaveBeenCalled();
  });

  it('should route the first decision by shortcut and avoid evaluator lookup', async () => {
    const params = parameters();
    delete params.lastDecisionTurn;
    const result = await routed(params, answer('large'));
    expect(result.result).toMatchObject({ route: 'default', source: 'shortcut', reason: 'first-decision' });
    expect(mocks.evaluator).not.toHaveBeenCalled();
    expect(result.evaluate).not.toHaveBeenCalled();
  });

  it('should preserve cadence when evaluator configuration is missing', async () => {
    mocks.evaluator.mockReturnValue(undefined);
    const result = await routed(parameters(), answer('large'), { fullRequired: true, evaluator: undefined });
    expect(result.result).toMatchObject({ route: 'default', source: 'fallback', reason: 'missing-evaluator' });
    expect(result.evaluate).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', (p: StrategistParameters) => { p.gameStates[8].players!['1']!.Source!.Turn = 7; }],
    ['foreign', (p: StrategistParameters) => { p.gameStates[8].options!.Source!.PlayerID = 2; }],
    ['gapped events', (p: StrategistParameters) => { p.gameStates[8].eventsAfter = 7_000_000; }],
    ['truncated', (p: StrategistParameters) => { p.gameStates[8].options!.Strategy.Rationale = 'x'.repeat(800); }],
  ])('should avoid evaluation for %s evidence', async (_label, invalidate) => {
    const params = parameters();
    invalidate(params);
    const result = await routed(params, answer('large'), { fullRequired: true });
    expect(result.result).toMatchObject({ route: 'default', source: 'fallback', reason: 'incomplete-state' });
    expect(result.evaluate).not.toHaveBeenCalled();
  });

  it.each(['small', 'default', 'large'] as const)('should accept an evaluator %s route once with compact projected state', async route => {
    const result = await routed(parameters(), answer(route));
    expect(result.result).toMatchObject({ route, source: 'evaluator', reason: 'evaluated', proposed: route, triage: { tier: route, source: 'evaluator' } });
    expect(result.evaluate).toHaveBeenCalledTimes(1);
    const [model, state, options] = result.evaluate.mock.calls[0] as unknown as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(model).toMatchObject({ provider: 'openai', name: 'evaluator-model' });
    expect(state).toMatchObject({ identity: { turn: 8 }, choices: { mandatory: 'unknown', deadlines: 'unknown' } });
    expect(options).toMatchObject({ purpose: 'triage' });
    expect(state.plan).toMatchObject({ rationale: { authorship: 'unknown' } });
  });

  it('should raise a small route when a full review is required', async () => {
    const result = await routed(parameters(), answer('small'), { fullRequired: true });
    expect(result.result).toMatchObject({ route: 'default', source: 'evaluator', reason: 'full-review-required', proposed: 'small', triage: { tier: 'default' } });
  });

  it('should keep the baseline route when a skip is proposed under unknown constraints', async () => {
    const due = await routed(parameters(), answer('skip'), { fullRequired: true });
    expect(due.result).toMatchObject({ route: 'default', source: 'fallback', reason: 'unknown-constraints', proposed: 'skip' });
    const offCadence = await routed(parameters(), answer('skip'));
    expect(offCadence.result).toMatchObject({ route: 'skip', source: 'fallback', reason: 'unknown-constraints', proposed: 'skip' });
  });

  it.each([
    ['invalid', answer('nope')],
    ['refusal', { answers: { route: { type: 'refusal', reason: 'not enough evidence' } } }],
  ])('should fall back for an %s answer', async (_label, response) => {
    const result = await routed(parameters(), response, { fullRequired: true });
    expect(result.result).toMatchObject({ route: 'default', source: 'fallback', reason: 'evaluation-failed' });
  });

  it('should fall back when evaluation fails', async () => {
    const params = parameters();
    const context = new VoxContext({}, 'strategic-routing-error');
    context.triage = true;
    context.evaluate = vi.fn().mockRejectedValue(new Error('provider failure')) as never;
    mocks.evaluator.mockReturnValue({ provider: 'openai', name: 'evaluator-model' });
    try {
      const result = await context.withRun({ parameters: params }, () => routeStrategicTurn('simple-strategist', params, context, false));
      expect(result).toMatchObject({ route: 'skip', source: 'fallback', reason: 'evaluation-failed' });
    } finally {
      await context.shutdown();
    }
  });

  it('should propagate an aborted run without fallback', async () => {
    const params = parameters();
    const context = new VoxContext({}, 'strategic-routing-abort');
    context.triage = true;
    context.evaluate = vi.fn(async () => { context.abort(); return answer('large') as never; }) as never;
    mocks.evaluator.mockReturnValue({ provider: 'openai', name: 'evaluator-model' });
    try {
      await expect(context.withRun({ parameters: params }, () => routeStrategicTurn('simple-strategist', params, context, false)))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await context.shutdown();
    }
  });

  it('should reject a late answer after the run is aborted', async () => {
    const params = parameters();
    const context = new VoxContext({}, 'strategic-routing-late-answer');
    context.triage = true;
    let settle!: (value: unknown) => void;
    context.evaluate = vi.fn(() => new Promise(resolve => { settle = resolve; })) as never;
    mocks.evaluator.mockReturnValue({ provider: 'openai', name: 'evaluator-model' });
    try {
      const pending = context.withRun({ parameters: params }, async run => {
        const routing = routeStrategicTurn('simple-strategist', params, context, false);
        await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
        run.abort();
        settle(answer('large'));
        return routing;
      });
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await context.shutdown();
    }
  });
});
