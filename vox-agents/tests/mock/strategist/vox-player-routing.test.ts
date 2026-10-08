/** Turn-loop integration with real routing, evaluation and usage sinks over synthetic HTTP. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));
import { VoxPlayer } from '../../../src/strategist/vox-player.js';
import { HumanDecisionBus } from '../../../src/strategist/human-decision-bus.js';
import { VoxSpanExporter } from '../../../src/utils/telemetry/vox-exporter.js';
import { spanProcessor, sqliteExporter } from '../../../src/instrumentation.js';
import { makeRecordingTracer } from '../../helpers/recording-tracer.js';
import type { PlayerConfig } from '../../../src/types/config.js';
import type { StrategistParameters } from '../../../src/strategist/strategy-parameters.js';
import type { VoxRunOptions } from '../../../src/infra/vox-run.js';

const fetchMock = vi.fn<typeof fetch>();

/** Return a native Decisions response, with measured usage even for a refusal. */
function response(route: string, refusal = false) {
  return new Response(JSON.stringify({
    model: 'gpt-6-luna',
    answers: [refusal
      ? { name: 'route', type: 'refusal', reason: 'Synthetic refusal' }
      : { name: 'route', type: 'choice', choice: route, confidence: 1, probabilities: ['skip', 'small', 'default', 'large'].map(value => ({ value, probability: value === route ? 1 : 0 })) }],
    usage: { input_tokens: 7, output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-key');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async () => response('small'));
  vi.spyOn(VoxSpanExporter.getInstance(), 'createContext').mockResolvedValue(undefined);
  vi.spyOn(VoxSpanExporter.getInstance(), 'closeContext').mockResolvedValue(undefined);
  vi.spyOn(spanProcessor, 'forceFlush').mockResolvedValue(undefined as never);
  vi.spyOn(sqliteExporter, 'forceFlush').mockResolvedValue(undefined as never);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** Run a finite sequence through the actual pause, refresh, route, decide and resume loop. */
async function turns(count: number, options: { triage?: boolean; interrupt?: number; overflow?: number; abort?: number; refuse?: number } = {}) {
  const recording = makeRecordingTracer();
  vi.spyOn(trace, 'getTracer').mockReturnValue(recording.tracer);
  const player = new VoxPlayer({
    playerID: 1, gameID: 'routing-game', initialTurn: 0, humanDecisionBus: new HumanDecisionBus(),
    playerConfig: {
      strategist: 'simple-strategist', triage: options.triage ?? true,
      pacing: { everyTurns: 3, interruption: 'importantEvents' },
      llms: { evaluator: { provider: 'openai-decisions', name: 'gpt-6-luna' } },
    } as PlayerConfig,
  });
  const tool = vi.spyOn(player.context, 'callTool').mockImplementation(async (name, _args, parameters) => {
    const p = parameters as StrategistParameters;
    const Source = { GameID: p.gameID, PlayerID: p.playerID, Turn: p.turn };
    if (name === 'get-players') return { '1': { Source, TeamID: 1, Gold: 20, GoldPerTurn: 2 } } as never;
    if (name === 'get-options') return {
      Source, Options: { GrandStrategies: [], Technologies: ['Writing'], Policies: [] },
      Strategy: { UpdatedTurn: 1, GrandStrategy: 'Culture' },
      Technology: { Next: 'Writing', UpdatedTurn: 1 }, Policy: { Next: null, UpdatedTurn: 1 },
    } as never;
    if (name === 'get-events') return (options.interrupt === p.turn
      ? { [p.turn]: [{ Type: 'DeclareWar', OriginatingPlayer: 1, TargetTeam: 2 }] } : {}) as never;
    return {} as never;
  });
  const decisions: { turn: number; tier: unknown; lastDecisionTurn: unknown }[] = [];
  const execute = vi.spyOn(player.context, 'execute').mockImplementation(async (_name, _input, _parameters, _tokens, overflow, execution) => {
    const p = player.context.currentParameters!;
    decisions.push({ turn: p.turn, tier: execution?.triage?.tier, lastDecisionTurn: p.lastDecisionTurn });
    if (options.overflow === p.turn && decisions.filter(d => d.turn === p.turn).length === 1) overflow?.();
    return undefined;
  });
  const realWithRun = player.context.withRun.bind(player.context);
  vi.spyOn(player.context, 'withRun').mockImplementation((runOptions: VoxRunOptions<StrategistParameters>, callback) => {
    const turn = runOptions.overrides!.turn!;
    return realWithRun(runOptions, callback as never).then(result => {
      if (turn >= count) player.abort(true);
      else player.notifyTurn(turn + 1);
      return result;
    });
  });
  if (options.abort || options.refuse) {
    fetchMock.mockImplementation(async () => {
      const turn = player.context.currentParameters!.turn;
      if (turn === options.abort) player.abort();
      return response('small', turn === options.refuse);
    });
  }
  player.notifyTurn(1);
  await player.execute();
  return { player, tool, execute, decisions, spans: recording.spans.filter(span => span.name.startsWith('strategist.turn.')) };
}

describe('per-turn strategic routing', () => {
  it('should preserve disabled cadence without evaluator calls or caller tiers', async () => {
    const { decisions, spans } = await turns(4, { triage: false });
    expect(decisions.map(d => [d.turn, d.tier])).toEqual([[1, undefined], [4, undefined]]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spans.every(span => span.attributes['routing.route'] === undefined)).toBe(true);
  });

  it('should evaluate between full reviews without letting small decisions move the full-review deadline', async () => {
    const { decisions } = await turns(4);
    expect(decisions.map(d => [d.turn, d.tier])).toEqual([[1, 'default'], [2, 'small'], [3, 'small'], [4, 'default']]);
    expect(decisions.map(d => d.lastDecisionTurn)).toEqual([undefined, 1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should keep the cadence on a skip recommendation and count evaluator usage on skipped turns', async () => {
    fetchMock.mockImplementation(async () => response('skip'));
    const { decisions, spans, tool, player } = await turns(3);
    expect(decisions.map(d => d.turn)).toEqual([1]);
    expect(spans[1].attributes).toMatchObject({ 'routing.route': 'skip', 'routing.source': 'fallback', 'routing.reason': 'unknown-constraints', 'tokens.input': 7, 'tokens.output': 2, 'tokens.reasoning': 1, 'tokens.usage.complete': false });
    expect(player.context.inputTokens).toBe(14);
    expect(tool.mock.calls.filter(c => c[0] === 'keep-status-quo')).toHaveLength(2);
    expect(tool.mock.calls.filter(c => c[0] === 'get-events').map(c => c[1])).toEqual([
      { GameID: 'routing-game', PlayerID: 1, After: 0, Before: 1_999_999 },
      { GameID: 'routing-game', PlayerID: 1, After: 1_999_999, Before: 2_999_999 },
      { GameID: 'routing-game', PlayerID: 1, After: 2_999_999, Before: 3_999_999 },
    ]);
  });

  it('should force at least the default tier on an important interruption', async () => {
    const { decisions } = await turns(2, { interrupt: 2 });
    expect(decisions.map(d => d.tier)).toEqual(['default', 'default']);
  });

  it('should reuse the selected route when narrowing the event window', async () => {
    fetchMock.mockResolvedValueOnce(response('skip')).mockResolvedValueOnce(response('skip')).mockResolvedValueOnce(response('large'));
    const { decisions } = await turns(4, { overflow: 4 });
    expect(decisions.filter(d => d.turn === 4).map(d => d.tier)).toEqual(['large', 'large']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should retain refusal usage on a fallback skip', async () => {
    const { decisions, spans } = await turns(2, { refuse: 2 });
    expect(decisions.map(d => d.turn)).toEqual([1]);
    expect(spans[1].attributes).toMatchObject({ 'routing.reason': 'evaluation-failed', 'tokens.input': 7, 'tokens.output': 2, 'tokens.reasoning': 1 });
  });

  it('should never start the strategist after an evaluator reply arrives following cancellation', async () => {
    const { decisions, tool, spans } = await turns(2, { abort: 2 });
    expect(decisions.map(d => d.turn)).toEqual([1]);
    expect(spans[1].status?.code).toBe(2);
    expect(tool.mock.calls.filter(c => c[0] === 'keep-status-quo')).toHaveLength(0);
    expect(tool.mock.calls.filter(c => c[0] === 'resume-game').length).toBeGreaterThanOrEqual(3);
  });
});
