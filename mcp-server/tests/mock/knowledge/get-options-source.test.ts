import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupStore } from '../helpers.js';
import { connectToolClient } from '../tool-client.js';
import { knowledgeManager } from '../../../src/server.js';
import { enumMappings } from '../../../src/utils/knowledge/enum.js';
import { composeVisibility } from '../../../src/utils/knowledge/visibility.js';
import { LuaFunction } from '../../../src/bridge/lua-function.js';
import createGetOptionsTool from '../../../src/tools/knowledge/get-options.js';
import type { KnowledgeStore } from '../../../src/knowledge/store.js';

// Keep the server singleton's startup resume request inside the mock boundary.
vi.mock(import('../../../src/bridge/http-client.js'), async importOriginal => {
  const module = await importOriginal();
  vi.spyOn(module.HttpClient.prototype, 'post').mockResolvedValue({ success: true });
  return module;
});
import { projectStrategicEvaluation } from '../../../../vox-agents/src/strategist/evaluation-projection.js';

vi.mock('../../../src/knowledge/getters/player-options.js', () => ({ getPlayerOptions: vi.fn() }));
vi.mock('../../../src/knowledge/getters/random-seeds.js', () => ({ getRandomSeeds: vi.fn(async () => null) }));
vi.mock('../../../src/knowledge/getters/player-information.js', () => ({ getPlayerInformations: vi.fn(async () => []) }));
vi.mock('../../../src/knowledge/getters/player-strategy.js', () => ({ getPlayerStrategy: vi.fn() }));
vi.mock('../../../src/knowledge/getters/player-persona.js', () => ({ getPlayerPersona: vi.fn() }));
vi.mock('../../../src/knowledge/getters/player-flavors.js', () => ({ getPlayerFlavors: vi.fn() }));
vi.mock('../../../src/knowledge/getters/player-relationships.js', () => ({ getPlayerRelationships: vi.fn(async () => ({})) }));
vi.mock('../../../src/utils/strategies/loader.js', () => ({
  loadGrandStrategyDescriptions: vi.fn(async () => ({})),
  loadFlavorDescriptions: vi.fn(async () => ({})),
}));
vi.mock('../../../src/tools/index.js', () => ({
  getTool: vi.fn(() => ({ getSummaries: async () => [] })),
}));

import { getPlayerOptions } from '../../../src/knowledge/getters/player-options.js';
import { getPlayerStrategy } from '../../../src/knowledge/getters/player-strategy.js';

let store: KnowledgeStore;
let gameIDSpy: ReturnType<typeof vi.spyOn>;
const strategyEnums = enumMappings.GrandStrategy;

beforeEach(async () => {
  vi.spyOn(LuaFunction.prototype, 'execute').mockResolvedValue({ success: true, result: [] } as any);
  store = await setupStore(10);
  gameIDSpy = vi.spyOn(knowledgeManager, 'getGameId').mockReturnValue('game-a');
  enumMappings.GrandStrategy = { 1: 'Culture' };
  vi.mocked(getPlayerStrategy).mockReset();
  vi.mocked(getPlayerOptions).mockResolvedValue([{
    PlayerID: 0,
    Turn: 22,
    EconomicStrategies: [],
    MilitaryStrategies: [],
    Technologies: ['Pottery'],
    NextResearch: 'Pottery',
    Policies: [],
    PolicyBranches: [],
    NextPolicy: null,
    NextBranch: null,
  }] as any);
});

afterEach(async () => {
  vi.restoreAllMocks();
  enumMappings.GrandStrategy = strategyEnums;
  await store.close();
});

describe('get-options source metadata', () => {
  it('returns the live option-row source and saved decision turns through MCP', async () => {
    await store.storeMutableKnowledge('StrategyChanges', 0, {
      GrandStrategy: 'Culture', EconomicStrategies: [], MilitaryStrategies: [], Rationale: 'Grow',
    } as any, composeVisibility([0]), undefined, 7);
    await store.storeMutableKnowledge('ResearchChanges', 0, {
      Technology: 'Pottery', Rationale: 'Unlock tools',
    } as any, composeVisibility([0]), undefined, 8);
    await store.storeMutableKnowledge('PolicyChanges', 0, {
      Policy: 'Tradition', IsBranch: 1, Rationale: 'Build cities',
    } as any, composeVisibility([0]), undefined, 9);

    const client = await connectToolClient(createGetOptionsTool());
    try {
      const result = await client.call({ PlayerID: 0, Mode: 'Strategy' });
      expect(result.Source).toEqual({ GameID: 'game-a', PlayerID: 0, Turn: 22 });
      expect(result.Strategy).toMatchObject({ UpdatedTurn: 7, Rationale: 'Grow' });
      expect(result.Technology).toMatchObject({ UpdatedTurn: 8, Rationale: 'Unlock tools' });
      expect(result.Policy).toMatchObject({ UpdatedTurn: 9, Rationale: 'Build cities' });
    } finally {
      await client.close();
    }
  });

  it('rejects a result if the active game changes during its reads', async () => {
    vi.mocked(getPlayerOptions).mockImplementation(async () => {
      gameIDSpy.mockReturnValue('game-b');
      return [{ PlayerID: 0, Turn: 22, Technologies: [], Policies: [], EconomicStrategies: [], MilitaryStrategies: [] }] as any;
    });
    const client = await connectToolClient(createGetOptionsTool());
    try {
      await expect(client.call({ PlayerID: 0, Mode: 'Strategy' })).rejects.toThrow('Game changed');
    } finally {
      await client.close();
    }
  });

  it('waits for saved strategy fallback before reading live options', async () => {
    let releaseFallback!: (value: unknown) => void;
    vi.mocked(getPlayerStrategy).mockReturnValue(new Promise(resolve => { releaseFallback = resolve; }) as any);
    vi.mocked(getPlayerOptions).mockClear();
    const client = await connectToolClient(createGetOptionsTool());
    try {
      const result = client.call({ PlayerID: 0, Mode: 'Strategy' });
      await vi.waitFor(() => expect(getPlayerStrategy).toHaveBeenCalled());
      expect(getPlayerOptions).not.toHaveBeenCalled();
      releaseFallback(null);
      await result;
      expect(getPlayerOptions).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it('omits Source.Turn when the live row has no turn and the projection rejects future or foreign sources', async () => {
    vi.mocked(getPlayerOptions).mockResolvedValue([{
      PlayerID: 0, EconomicStrategies: [], MilitaryStrategies: [], Technologies: [], Policies: [], PolicyBranches: [],
    }] as any);
    const client = await connectToolClient(createGetOptionsTool());
    try {
      const report = await client.call({ PlayerID: 0, Mode: 'Strategy' });
      expect(report.Source).toEqual({ GameID: 'game-a', PlayerID: 0 });

      // The live options row may be ahead of knowledgeManager's turn; its source bounds the report.
      vi.mocked(getPlayerOptions).mockResolvedValueOnce([{
        PlayerID: 0, Turn: 22, EconomicStrategies: [], MilitaryStrategies: [], Technologies: [], Policies: [], PolicyBranches: [],
      }] as any);
      const futureReport = await client.call({ PlayerID: 0, Mode: 'Strategy' });
      const laggingProjection = projectStrategicEvaluation({
        gameID: 'game-a', playerID: 0, turn: 10, lastDecisionTurn: 8, before: 10_999_999,
        gameStates: { 10: { turn: 10, options: futureReport, reports: {} } },
      } as any);
      expect(laggingProjection.choices.observedTurn).toBeNull();
      expect(laggingProjection.limitations.excluded).toContain('options');

      for (const Source of [
        { GameID: 'other-game', PlayerID: 0, Turn: 22 },
        { GameID: 'game-a', PlayerID: 0, Turn: 23 },
      ]) {
        const projection = projectStrategicEvaluation({
          gameID: 'game-a', playerID: 0, turn: 22, lastDecisionTurn: 8, before: 22_999_999,
          gameStates: { 22: { turn: 22, options: { ...report, Source }, reports: {} } },
        } as any);
        expect(projection.choices.observedTurn).toBeNull();
        expect(projection.limitations.excluded).toContain('options');
      }
    } finally {
      await client.close();
    }
  });
});
