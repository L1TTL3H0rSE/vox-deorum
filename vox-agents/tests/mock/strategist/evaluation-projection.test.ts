import { describe, expect, it } from 'vitest';
import { projectStrategicEvaluation, strategicProjectionLimits } from '../../../src/strategist/evaluation-projection.js';
import { refreshGameState, type GameState } from '../../../src/strategist/strategy-parameters.js';
import { createFakeVoxContext, makeGameState, makeStrategistParameters } from '../../helpers/fake-vox-context.js';

/** Model the existing report contracts, including independent live and saved timestamps. */
function reports(turn = 8): Pick<GameState, 'players' | 'options'> {
  const Source = { GameID: 'test-game', PlayerID: 1, Turn: turn };
  return {
    players: { '1': { Source, Gold: 0, GoldPerTurn: -3, NextPolicyTurns: 0 }, '2': { Gold: 999, Secret: 'hidden-opponent' } },
    options: {
      Source, Options: { GrandStrategies: [], Technologies: ['Writing'], Policies: ['Tradition'] },
      Strategy: { UpdatedTurn: 5, GrandStrategy: 'Culture', Rationale: 'Untrusted model hypothesis' },
      Technology: { Next: 'Writing', UpdatedTurn: 5 }, Policy: { Next: 'Tradition', UpdatedTurn: 5 },
    },
  } as Pick<GameState, 'players' | 'options'>;
}

/** Cache a provenance-bound immutable event slice, with a deliberately different merged window. */
function slice(turn: number, after: number, events: GameState['events'] = {}): GameState {
  return makeGameState(turn, {
    ...reports(turn), events, eventsAfter: after, eventsBefore: turn * 1_000_000 + 999_999,
    eventsPerspective: { gameID: 'test-game', playerID: 1 },
    mergedEvents: { '8': [{ Type: 'ShouldNotReplaceImmutableEvents' }] },
  });
}

/** Supply a target turn and independent last strategic decision. */
function parameters(state = slice(8, 6_000_000)) {
  return makeStrategistParameters({ turn: 8, after: 8_000_000, before: 8_999_999, lastDecisionTurn: 5, gameStates: { 8: state } });
}

/** Freeze every nested fixture so projection cannot silently mutate a cached report. */
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

describe('strategic evaluation projection', () => {
  it('should project the actual refresh result with source dates and no evaluator call', async () => {
    const ctx = createFakeVoxContext();
    const params = parameters();
    params.gameStates = {};
    params.after = 6_000_000;
    ctx.respondWith('get-players', reports().players);
    ctx.respondWith('get-options', reports().options);
    ctx.respondWith('get-events', { '6': [{ Type: 'DeclareWar' }], '8': [{ Type: 'MakePeace' }] });
    for (const name of ['get-cities', 'get-victory-progress', 'get-military-report']) ctx.respondWith(name, {});
    await refreshGameState(ctx.asContext(), params);
    const calls = ctx.calls().length;
    freeze(params);
    const result = projectStrategicEvaluation(params);
    expect(result).toEqual(projectStrategicEvaluation(params));
    expect(result.identity).toEqual({ gameID: 'test-game', playerID: 1, turn: 8 });
    expect(result.plan).toMatchObject({ recordedTurn: 5, grandStrategy: 'Culture' });
    expect(result.plan?.rationale).toMatchObject({ kind: 'untrusted-text', authorship: 'unknown' });
    expect(result.lastDecision.rationale).toBeNull();
    expect(result.events.items.map(item => item.turn)).toEqual([6, 8]);
    expect(result.events.coverageComplete).toBe(true);
    expect(result.ownState?.gold).toBe(0);
    expect(result.ownState?.militaryUnits).toBeNull();
    expect(JSON.stringify(result)).not.toContain('hidden-opponent');
    expect(ctx.calls()).toHaveLength(calls);
    expect(ctx.evaluate).not.toHaveBeenCalled();
  });

  it('should preserve skipped-turn events across slices and report a missing range', () => {
    const params = parameters(slice(8, 8_000_000, { '8': [{ Type: 'New' }] }));
    params.gameStates[6] = slice(6, 6_000_000, { '6': [{ Type: 'Older' }] });
    const incomplete = projectStrategicEvaluation(params);
    expect(incomplete.events.items.map(item => item.turn)).toEqual([6, 8]);
    expect(incomplete.events.coverageComplete).toBe(false);
    expect(incomplete.events.uncovered).toEqual([{ after: 6_999_999, before: 8_000_000 }]);
    params.gameStates[8] = slice(8, 6_000_000, { '6': [{ Type: 'Older' }], '7': [{ Type: 'Middle' }], '8': [{ Type: 'New' }] });
    const complete = projectStrategicEvaluation(params);
    expect(complete.events.items.map(item => item.type)).toEqual(['Older', 'Middle', 'New']);
    expect(complete.events.coverageComplete).toBe(true);
    expect(JSON.stringify(complete)).not.toContain('ShouldNotReplaceImmutableEvents');
  });

  it('should keep quiet choices separate from bounded event details', () => {
    const state = slice(8, 6_000_000, { '8': Array.from({ length: 500 }, (_, n) => ({ Type: 'Movement', Value: n, Text: 'x'.repeat(2000) })) });
    const params = parameters(state);
    const result = projectStrategicEvaluation(params);
    expect(result.events.items).toHaveLength(strategicProjectionLimits.events);
    expect(result.events.omittedEntries).toBe(500 - strategicProjectionLimits.events);
    expect(result.limitations.truncated).toContain('events');
    expect(result.choices.policy).toMatchObject({ available: ['Tradition'], estimatedAvailableInTurns: 0 });
    state.players = reports(7).players;
    const staleEstimate = projectStrategicEvaluation(params).choices;
    expect(staleEstimate.observedTurn).toBe(8);
    expect(staleEstimate.policy.estimateObservedTurn).toBe(7);
    // Available now is not proof that the engine requires a choice before continuing.
    expect(result.choices.mandatory).toBe('unknown');
    expect(result.choices.deadlines).toBe('unknown');
    expect(result.risks.assessment).toBe('unknown');
    expect(JSON.stringify(result).length).toBeLessThan(25_000);
  });

  it.each(['GameID', 'PlayerID', 'Turn'] as const)('should omit a mismatching %s report before copying its payload', key => {
    const state = slice(8, 6_000_000);
    const source = { GameID: 'test-game', PlayerID: 1, Turn: 8, [key]: key === 'GameID' ? 'another-game' : 9 };
    state.players = { '1': { Source: source, CurrentResearch: 'excluded-marker' } } as GameState['players'];
    state.options!.Source = source;
    state.options!.Strategy.Rationale = 'excluded-marker';
    const result = projectStrategicEvaluation(parameters(state));
    expect(result.ownState).toBeNull();
    expect(result.plan).toBeNull();
    expect(result.limitations.excluded).toEqual(expect.arrayContaining(['ownState', 'options']));
    expect(JSON.stringify(result)).not.toContain('excluded-marker');
  });

  it('should omit undated live data and independently future-dated saved decisions', () => {
    const state = slice(8, 6_000_000);
    delete state.options!.Source!.Turn;
    expect(projectStrategicEvaluation(parameters(state)).plan).toBeNull();
    state.options!.Source!.Turn = 8;
    state.options!.Strategy.UpdatedTurn = 9;
    state.options!.Strategy.Rationale = 'future-decision';
    const result = projectStrategicEvaluation(parameters(state));
    expect(result.plan).toBeNull();
    expect(result.choices.research.selected).toBe('Writing');
    expect(JSON.stringify(result)).not.toContain('future-decision');
  });

  it('should select an earlier snapshot, mark it stale and never read a future cache', () => {
    const params = parameters(slice(7, 6_000_000));
    params.gameStates = { 7: params.gameStates[8], 9: slice(9, 6_000_000) };
    params.gameStates[9].options!.Strategy.Rationale = 'future-cache';
    const result = projectStrategicEvaluation(params);
    expect(result.snapshot.cacheTurn).toBe(7);
    expect(result.ownState?.observedTurn).toBe(7);
    expect(result.limitations.stale).toEqual(expect.arrayContaining(['snapshot', 'ownState', 'options']));
    expect(JSON.stringify(result)).not.toContain('future-cache');
  });

  it('should compute deltas only from an exactly dated last-decision baseline', () => {
    const params = parameters();
    params.gameStates[5] = slice(5, 5_000_000);
    (params.gameStates[5].players!['1'] as { Gold: number }).Gold = 10;
    expect(projectStrategicEvaluation(params).changes.deltas.gold).toBe(-10);
    params.gameStates[5].players = reports(4).players;
    const result = projectStrategicEvaluation(params);
    expect(result.changes.deltas).toEqual({});
    expect(result.limitations.missing).toContain('changes.baseline');
    params.gameStates[5].players = reports(5).players;
    params.gameStates[8].players = reports(4).players;
    expect(projectStrategicEvaluation(params).changes.deltas).toEqual({});
  });

  it('should not relabel a different saved rationale as the last decision', () => {
    const state = slice(8, 6_000_000);
    state.options!.Strategy.UpdatedTurn = 7;
    const result = projectStrategicEvaluation(parameters(state));
    expect(result.plan?.rationale.kind).toBe('untrusted-text');
    expect(result.lastDecision.rationale).toBeNull();
    expect(result.limitations.missing).toContain('lastDecision.rationale');
  });

  it.each(['foreign', 'legacy', 'malformed'])('should not claim event coverage for %s slices', kind => {
    const state = slice(8, 6_000_000, { '8': [{ Type: 'Discarded' }] });
    if (kind === 'foreign') state.eventsPerspective!.playerID = 2;
    if (kind === 'legacy') delete state.eventsPerspective;
    if (kind === 'malformed') state.events = { broken: 1 } as unknown as GameState['events'];
    const result = projectStrategicEvaluation(parameters(state));
    expect(result.events.items).toEqual([]);
    expect(result.events.coverageComplete).toBe(false);
  });

  it('should filter future events and omit unbounded resource annotations recursively', () => {
    const state = slice(8, 6_000_000, {
      '8': [{ Type: 'TileRevealed', Nested: [{ Resource: 'future-resource', Terrain: 'Grassland' }] }],
      '9': [{ Type: 'future-event' }],
    });
    const result = projectStrategicEvaluation(parameters(state));
    expect(result.events.items).toHaveLength(1);
    expect(result.events.items[0].details).toContain('Grassland');
    expect(JSON.stringify(result)).not.toContain('future-');
    expect(result.limitations.incomplete).toContain('events.resource-details');
  });

  it('should trim original IDs but reject consolidated data beyond a partial-turn upper bound', () => {
    const params = parameters(slice(8, 6_000_000, { '8': [{ Type: 'CannotLocateWithinTurn' }] }));
    params.before = 8_000_004;
    expect(projectStrategicEvaluation(params).events.items).toEqual([]);
    params.gameStates[8].events = { events: [
      { ID: 8_000_004, Turn: 8, Type: 'InRange' }, { ID: 8_000_005, Turn: 8, Type: 'Later' },
    ] };
    expect(projectStrategicEvaluation(params).events.items.map(item => item.type)).toEqual(['InRange']);
  });

  it('should distinguish no decision baseline from an empty window after a current-turn decision', () => {
    const params = parameters(slice(8, 8_000_000));
    delete params.lastDecisionTurn;
    const initial = projectStrategicEvaluation(params);
    expect(initial.events.fromTurn).toBe(8);
    expect(initial.lastDecision.turn).toBeNull();
    params.lastDecisionTurn = 8;
    const sameTurn = projectStrategicEvaluation(params);
    expect(sameTurn.events.empty).toBe(true);
    expect(sameTurn.events.coverageComplete).toBe(true);
    expect(sameTurn.events.items).toEqual([]);
  });

  it('should bound lists and rationale with explicit limitations', () => {
    const state = slice(8, 6_000_000);
    state.options!.Options.Technologies = Array.from({ length: 100 }, (_, n) => `Option${n}`);
    state.options!.Strategy.Rationale = 'x'.repeat(10_000);
    const result = projectStrategicEvaluation(parameters(state));
    expect(result.choices.research.available).toHaveLength(strategicProjectionLimits.list);
    expect(result.plan?.rationale.text).toHaveLength(strategicProjectionLimits.text);
    expect(result.limitations.truncated).toEqual(expect.arrayContaining(['choices.research', 'plan.rationale']));
  });

  it('should retain event provenance on a narrower refresh without stamping a legacy slice', async () => {
    const ctx = createFakeVoxContext();
    for (const name of ['get-players', 'get-options', 'get-events', 'get-cities', 'get-victory-progress', 'get-military-report']) ctx.respondWith(name, {});
    const params = parameters(slice(8, 6_000_000, { '6': [{ Type: 'Retained' }] }));
    await refreshGameState(ctx.asContext(), params);
    expect(params.gameStates[8].eventsAfter).toBe(6_000_000);
    expect(params.gameStates[8].eventsBefore).toBe(8_999_999);
    delete params.gameStates[8].eventsPerspective;
    await refreshGameState(ctx.asContext(), params);
    expect(params.gameStates[8].eventsPerspective).toBeUndefined();
    expect(projectStrategicEvaluation(params).events.items).toEqual([]);
  });

  it('should keep the original event perspective when seat parameters change during refresh', async () => {
    const ctx = createFakeVoxContext();
    const params = parameters();
    params.gameStates = {};
    for (const name of ['get-players', 'get-options', 'get-cities', 'get-victory-progress', 'get-military-report']) ctx.respondWith(name, {});
    ctx.onTool('get-events', async () => {
      params.gameID = 'new-game';
      params.playerID = 2;
      params.before = 9_999_999;
      return { '8': [{ Type: 'OldGameEvent' }] };
    });
    await refreshGameState(ctx.asContext(), params);
    expect(params.gameStates[8].eventsPerspective).toEqual({ gameID: 'test-game', playerID: 1 });
    expect(params.gameStates[8].eventsBefore).toBe(8_999_999);
    expect(projectStrategicEvaluation(params).events.items).toEqual([]);
  });
});
