import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupStore } from '../helpers.js';
import { connectToolClient } from '../tool-client.js';
import { knowledgeManager } from '../../../src/server.js';
import { LuaFunction } from '../../../src/bridge/lua-function.js';
import createGetPlayersTool from '../../../src/tools/knowledge/get-players.js';
import type { KnowledgeStore } from '../../../src/knowledge/store.js';

// Keep the server singleton's startup resume request inside the mock boundary.
vi.mock(import('../../../src/bridge/http-client.js'), async importOriginal => {
  const module = await importOriginal();
  vi.spyOn(module.HttpClient.prototype, 'post').mockResolvedValue({ success: true });
  return module;
});

const liveTurn = vi.hoisted(() => ({ value: 31, switchGame: false }));
vi.mock('../../../src/knowledge/getters/player-summary.js', () => ({
  getPlayerSummaries: vi.fn(async () => {
    if (liveTurn.switchGame) liveTurn.value = 32;
    return [{ Key: 0, Turn: 31, Player0: 2, Era: 'Ancient', Cities: 1, Population: 1 }];
  }),
}));
vi.mock('../../../src/knowledge/getters/random-seeds.js', () => ({ getRandomSeeds: vi.fn(async () => null) }));
vi.mock('../../../src/knowledge/getters/player-information.js', () => ({
  getPlayerInformations: vi.fn(async () => [{ Key: 0, Civilization: 'Rome', Leader: 'Augustus', TeamID: 0, IsMajor: 1 }]),
}));
vi.mock('../../../src/knowledge/getters/player-opinions.js', () => ({ getPlayerOpinions: vi.fn(async () => null) }));
vi.mock('../../../src/utils/knowledge/cached.js', () => ({
  readPlayerKnowledge: vi.fn(async () => null),
  readPublicKnowledgeBatch: vi.fn(async (_table, fetch) => fetch()),
}));

let store: KnowledgeStore;

beforeEach(async () => {
  vi.spyOn(LuaFunction.prototype, 'execute').mockResolvedValue({ success: true, result: [] } as any);
  liveTurn.value = 31;
  liveTurn.switchGame = false;
  store = await setupStore(10);
  vi.spyOn(knowledgeManager, 'getGameId').mockImplementation(() => liveTurn.value === 31 ? 'game-a' : 'game-b');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
});

describe('get-players source metadata', () => {
  it('attaches viewer provenance after event cleanup can normalize identifier keys', async () => {
    const client = await connectToolClient(createGetPlayersTool());
    try {
      const result = await client.call({ PlayerID: 0 });
      expect(result['0'].Source).toEqual({ GameID: 'game-a', PlayerID: 0, Turn: 31 });
    } finally {
      await client.close();
    }
  });

  it('rejects a player report if the active game changes during refresh', async () => {
    liveTurn.switchGame = true;
    const client = await connectToolClient(createGetPlayersTool());
    try {
      await expect(client.call({ PlayerID: 0 })).rejects.toThrow('Game changed');
    } finally {
      await client.close();
    }
  });
});
