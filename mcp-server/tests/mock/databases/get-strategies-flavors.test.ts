/**
 * Mock-tier tests for the strategy/flavor DB-lookup tools:
 *   - get-economic-strategies / get-military-strategies (AiStrategyTool)
 *   - get-flavors (DatabaseQueryTool over the flavors JSON)
 *
 * The mock tier has no game DB, so the raw DB read is stubbed at the boundary:
 *   - For the strategy tools, fetchSummaries() (which would call
 *     gameDatabase.getDatabase() + Kysely + writeJsonIfChanged) is spied to return
 *     canned strategy rows. This still exercises the real search / single-result
 *     expansion / localize / output-shaping path of the abstraction.
 *   - For get-flavors, loadFlavorDescriptions() is mocked so no JSON file is read.
 *   - gameDatabase.localizeObjects is a pass-through (it otherwise throws with no
 *     localization DB).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// get-flavors loads descriptions from a JSON file via the loader; mock that boundary.
vi.mock('../../../src/utils/strategies/loader.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    loadFlavorDescriptions: vi.fn(),
  };
});

import { gameDatabase } from '../../../src/server.js';
import { loadFlavorDescriptions } from '../../../src/utils/strategies/loader.js';
import createGetEconomicStrategyTool from '../../../src/tools/databases/get-economic-strategy.js';
import createGetMilitaryStrategyTool from '../../../src/tools/databases/get-military-strategy.js';
import createGetFlavorsTool from '../../../src/tools/databases/get-flavors.js';

const ECON_ROWS = [
  { Type: 'Expansion', Production: { Expansion: 10 }, Overall: { Growth: 5 }, Description: 'Settle wide' },
  { Type: 'Growth', Production: { Growth: 8 }, Overall: { Growth: 12 }, Description: 'Tall cities' },
  { Type: 'Tradition', Production: { Culture: 4 }, Overall: { Culture: 9 }, Description: 'Cultural focus' },
];

const MIL_ROWS = [
  { Type: 'Conquest', Production: { Offense: 10 }, Overall: { Offense: 8 }, Description: 'Crush enemies' },
  { Type: 'Defense', Production: { Defense: 9 }, Overall: { Defense: 7 }, Description: 'Hold the line' },
];

beforeEach(() => {
  vi.spyOn(gameDatabase, 'localizeObjects').mockImplementation(async (rows: any) => rows);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Create an economic-strategy tool with fetchSummaries stubbed to canned rows. */
function econTool(rows = ECON_ROWS) {
  const tool = createGetEconomicStrategyTool();
  vi.spyOn(tool as any, 'fetchSummaries').mockResolvedValue(rows);
  return tool;
}

function milTool(rows = MIL_ROWS) {
  const tool = createGetMilitaryStrategyTool();
  vi.spyOn(tool as any, 'fetchSummaries').mockResolvedValue(rows);
  return tool;
}

// The listing path is shared base behavior over each tool's own canned rows, so one table
// covers both strategy tools and pins their distinct output shapes.
describe('get-economic-strategies / get-military-strategies', () => {
  it.each([
    {
      tool: 'get-economic-strategies',
      makeTool: econTool,
      count: 3,
      types: ['Expansion', 'Growth', 'Tradition'],
      sample: { Type: 'Growth', Production: { Growth: 8 }, Overall: { Growth: 12 }, Description: 'Tall cities' },
    },
    {
      tool: 'get-military-strategies',
      makeTool: milTool,
      count: 2,
      types: ['Conquest', 'Defense'],
      sample: { Type: 'Conquest', Production: { Offense: 10 }, Overall: { Offense: 8 }, Description: 'Crush enemies' },
    },
  ])('$tool lists all strategies (no search) with Production/Overall/Description preserved', async ({ makeTool, count, types, sample }) => {
    const result = await makeTool().execute({ MaxResults: 20 } as any);

    expect(result.Count).toBe(count);
    expect(result.Items.map((i: any) => i.Type).sort()).toEqual(types);
    const found = result.Items.find((i: any) => i.Type === sample.Type);
    expect(found.Production).toEqual(sample.Production);
    expect(found.Overall).toEqual(sample.Overall);
    expect(found.Description).toBe(sample.Description);
  });

  it('fuzzy-searches by Type and collapses a unique exact match to one item', async () => {
    const tool = econTool();
    const result = await tool.execute({ Search: 'Expansion', MaxResults: 20 } as any);

    expect(result.Count).toBe(1);
    expect(result.Items[0].Type).toBe('Expansion');
    expect(result.Items[0].Description).toBe('Settle wide');
  });
});

describe('get-flavors', () => {
  beforeEach(() => {
    (loadFlavorDescriptions as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      Offense: 'Tendency toward aggressive military action',
      Defense: 'Tendency to fortify and protect',
      Gold: 'Tendency to prioritize economy',
    });
  });

  it('maps the flavor description map into Name/Description rows', async () => {
    const tool = createGetFlavorsTool();
    const result = await tool.execute({ MaxResults: 20 } as any);

    expect(result.Count).toBe(3);
    const names = result.Items.map((i: any) => i.Name).sort();
    expect(names).toEqual(['Defense', 'Gold', 'Offense']);
    const offense = result.Items.find((i: any) => i.Name === 'Offense');
    expect(offense.Description).toBe('Tendency toward aggressive military action');
  });

  it('fuzzy-searches flavors by Name (identifier field is Name, not Type)', async () => {
    const tool = createGetFlavorsTool();
    const result = await tool.execute({ Search: 'Offense', MaxResults: 20 } as any);

    expect(result.Count).toBe(1);
    expect(result.Items[0].Name).toBe('Offense');
    expect(result.Items[0].Description).toBe('Tendency toward aggressive military action');
  });

  it('returns an empty list when no flavor descriptions exist', async () => {
    (loadFlavorDescriptions as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const tool = createGetFlavorsTool();
    const result = await tool.execute({ MaxResults: 20 } as any);

    expect(result.Count).toBe(0);
    expect(result.Items).toEqual([]);
  });
});
