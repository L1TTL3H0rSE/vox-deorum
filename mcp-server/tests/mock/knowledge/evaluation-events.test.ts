import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupStore, seedPlayer } from '../helpers.js';
import { connectToolClient } from '../tool-client.js';
import { applyVisibility, composeVisibility } from '../../../src/utils/knowledge/visibility.js';
import createGetEventsTool from '../../../src/tools/knowledge/get-events.js';
import { LuaFunction } from '../../../src/bridge/lua-function.js';
import { knowledgeManager } from '../../../src/server.js';
import type { KnowledgeStore } from '../../../src/knowledge/store.js';
import { createFakeVoxContext, makeStrategistParameters } from '../../../../vox-agents/tests/helpers/fake-vox-context.js';
import { refreshGameState } from '../../../../vox-agents/src/strategist/strategy-parameters.js';
import { projectStrategicEvaluation } from '../../../../vox-agents/src/strategist/evaluation-projection.js';

// Keep the server singleton's startup resume request inside the mock boundary.
vi.mock(import('../../../src/bridge/http-client.js'), async importOriginal => {
  const module = await importOriginal();
  vi.spyOn(module.HttpClient.prototype, 'post').mockResolvedValue({ success: true });
  return module;
});

const after = 5_000_000;
const before = 5_000_010;
let store: KnowledgeStore;
let client: Awaited<ReturnType<typeof connectToolClient>>;

beforeEach(async () => {
  vi.spyOn(LuaFunction.prototype, 'execute').mockImplementation(function (this: LuaFunction) {
    return Promise.resolve(this.name === 'getRandomSeeds'
      ? { success: true, result: { SyncRandSeed: 1, MapRandSeed: 2 } }
      : { success: false }) as any;
  });
  vi.spyOn(knowledgeManager, 'getGameId').mockReturnValue('test');
  store = await setupStore(5);
  await seedPlayer(store, 0);
  await store.storeMutableKnowledge('PlayerSummaries', 0, {
    Key: 0, Era: 'Medieval', Cities: 1, Population: 5, Gold: 100, GoldPerTurn: 2,
    Technologies: 3, Player0: 2,
  } as any, [0], undefined, 5);
  const visible = [0];
  const rows = [
    { id: 4_999_999, turn: 4, type: 'OldEvent', payload: {} },
    { id: 5_000_002, turn: 5, type: 'VisibleEvent', payload: { ID: 77, Turn: 99, Type: 'SpoofedEvent', Detail: 'visible' } },
    { id: 5_000_004, turn: 5, type: 'HiddenEvent', payload: { Detail: 'opponent only' }, visibleTo: [1] },
    { id: 5_000_011, turn: 5, type: 'FutureEvent', payload: {} },
  ];
  for (const row of rows) {
    const data = applyVisibility({ ID: row.id, Turn: row.turn, Type: row.type, Payload: row.payload } as any, composeVisibility(row.visibleTo ?? visible));
    await store.getDatabase().insertInto('GameEvents').values(data).execute();
  }
  client = await connectToolClient(createGetEventsTool());
});

afterEach(async () => {
  await client.close();
  vi.restoreAllMocks();
  await store.close();
});

describe('strategic evaluation event projection through get-events', () => {
  it('projects viewer-visible events from the bounded consolidated refresh report', async () => {
    const context = createFakeVoxContext();
    const parameters = makeStrategistParameters({ turn: 5, playerID: 0, gameID: 'test', after, before, lastDecisionTurn: 4 });
    let toolError: unknown;
    context.onTool('get-events', async args => {
      try {
        return await client.call({ GameID: args.GameID, After: args.After, Before: args.Before, PlayerID: parameters.playerID });
      } catch (error) {
        toolError = error;
        return { isError: true, error: String(error) };
      }
    });
    context.respondWith('get-players', {
      '0': { Source: { GameID: 'test', PlayerID: 0, Turn: 5 }, Gold: 100 },
    });
    context.respondWith('get-cities', {});
    context.respondWith('get-options', { Source: { GameID: 'test', PlayerID: 0, Turn: 5 } });
    context.respondWith('get-victory-progress', {});
    context.respondWith('get-military-report', {});

    const state = await refreshGameState(context.asContext(), parameters);
    expect(toolError).toBeUndefined();
    expect(context.calls('get-events')[0].args).toEqual({ GameID: 'test', PlayerID: 0, After: after, Before: before });
    const projected = projectStrategicEvaluation(parameters);

    expect(state.events).toMatchObject({ '5': [{ Type: 'VisibleEvent', Detail: 'visible' }] });
    expect(state.eventsAfter).toBe(after);
    expect(state.eventsBefore).toBe(before);
    expect(state.eventsPerspective).toEqual({ gameID: 'test', playerID: 0 });
    expect(projected.identity).toEqual({ gameID: 'test', playerID: 0, turn: 5 });
    expect(projected.events).toMatchObject({ coverageComplete: true, after, before, items: [{ turn: 5, type: 'VisibleEvent' }] });
    expect(JSON.stringify(projected.events)).not.toContain('HiddenEvent');
    expect(JSON.stringify(projected.events)).not.toContain('OldEvent');
    expect(JSON.stringify(projected.events)).not.toContain('FutureEvent');
    expect(JSON.stringify(projected.events)).not.toContain('SpoofedEvent');
  });

  it('projects original events using authoritative row identity over conflicting payload fields', async () => {
    const original = await client.call({ GameID: 'test', PlayerID: 0, After: after, Before: before, Original: true });
    const parameters = makeStrategistParameters({ turn: 5, playerID: 0, gameID: 'test', after, before, lastDecisionTurn: 4 });
    parameters.gameStates[5] = {
      turn: 5,
      events: original,
      eventsAfter: after,
      eventsBefore: before,
      eventsPerspective: { gameID: parameters.gameID, playerID: parameters.playerID },
      reports: {},
    };

    expect(original.events).toHaveLength(1);
    expect(original.events[0]).toMatchObject({
      ID: 5_000_002,
      Turn: 5,
      Type: 'VisibleEvent',
      Detail: 'visible',
    });
    const projected = projectStrategicEvaluation(parameters);
    expect(projected.events).toMatchObject({ coverageComplete: true, items: [{ turn: 5, type: 'VisibleEvent' }] });
    expect(JSON.stringify(projected.events)).not.toContain('SpoofedEvent');
  });

  it('rejects an event request for a different game before reading the store', async () => {
    const getStore = vi.spyOn(knowledgeManager, 'getStore').mockReturnValue(store);
    getStore.mockClear();

    await expect(client.call({ GameID: 'other-game', PlayerID: 0, After: after, Before: before }))
      .rejects.toThrow(/does not match the active game/);
    expect(getStore).not.toHaveBeenCalled();
  });

  it('rejects results when the active game changes after the store query', async () => {
    const getGameId = vi.spyOn(knowledgeManager, 'getGameId')
      .mockReturnValueOnce('test')
      .mockReturnValueOnce('other-game');
    const getStore = vi.spyOn(knowledgeManager, 'getStore').mockReturnValue(store);
    getStore.mockClear();

    await expect(client.call({ GameID: 'test', PlayerID: 0, After: after, Before: before }))
      .rejects.toThrow(/Active game changed while retrieving events/);
    expect(getStore).toHaveBeenCalledTimes(1);
  });
});
