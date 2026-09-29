/**
 * Tests for the pinned deal-schema helpers — focused on `symmetrizeDeal`, which completes mutual
 * agreements (Declaration of Friendship / Defensive Pact / Research Agreement / Peace Treaty) onto
 * both sides so a one-sided pact is never inspected or stored.
 */
import { describe, it, expect } from 'vitest';
import {
  symmetrizeDeal,
  applyDealDurations,
  SYMMETRIC_PROMISE_TYPES,
  TARGETED_PROMISE_TYPES,
  PROMISE_METADATA,
  PROMISE_TYPES,
  DealPayloadSchema,
  PromiseTermSchema,
  durationForPromiseType,
  type DealPayload,
  type PromiseTerm,
  type TradeItem,
} from '../../../src/utils/deal-schema.js';

const deal = (items: TradeItem[]): DealPayload => ({ version: 1, items, promises: [] });
const promiseDeal = (promises: PromiseTerm[]): DealPayload => ({ version: 1, items: [], promises });

describe('DealPayloadSchema wire-shape coercion', () => {
  it('coerces the DLL empty-Lua-table encoding ({}) of items/promises to []', () => {
    // ConvertLuaToJsonValue only emits a JSON array for a dense table with maxIndex > 0, so the
    // in-game deal screen's empty list arrives as `{}` — e.g. a gold-only deal's `promises`.
    const parsed = DealPayloadSchema.safeParse({
      version: 1,
      items: [{ fromPlayerID: 1, toPlayerID: 3, itemType: 'GOLD', amount: 50 }],
      promises: {},
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data!.items).toHaveLength(1);
    expect(parsed.data!.promises).toEqual([]);
  });

  it('coerces both lists when the deal is empty, and still defaults missing lists', () => {
    const bothEmpty = DealPayloadSchema.safeParse({ version: 1, items: {}, promises: {} });
    expect(bothEmpty.success).toBe(true);
    expect(bothEmpty.data).toMatchObject({ items: [], promises: [] });

    const omitted = DealPayloadSchema.safeParse({ version: 1 });
    expect(omitted.success).toBe(true);
    expect(omitted.data).toMatchObject({ items: [], promises: [] });
  });

  it('still rejects a non-empty object and other junk in the list fields', () => {
    expect(DealPayloadSchema.safeParse({ version: 1, items: { a: 1 }, promises: [] }).success).toBe(false);
    expect(DealPayloadSchema.safeParse({ version: 1, items: 'nope', promises: [] }).success).toBe(false);
    expect(DealPayloadSchema.safeParse({ version: 1, items: [], promises: { promiserID: 1 } }).success).toBe(false);
  });
});

describe('PROMISE_METADATA (single source of truth) + derived sets', () => {
  it('holds exactly the promises the tactical AI honors (the non-honored ones are out of the contract)', () => {
    expect([...PROMISE_TYPES].sort()).toEqual(
      ['BORDER', 'COOP_WAR', 'EXPANSION', 'MILITARY', 'NO_DIGGING']
    );
    // The non-honored promises are commented out of the contract, so the schema rejects them.
    for (const t of ['SPY', 'NO_CONVERT', 'BULLY_CITY_STATE', 'ATTACK_CITY_STATE']) {
      expect(PromiseTermSchema.safeParse({ promiserID: 1, recipientID: 3, promiseType: t }).success).toBe(false);
    }
    expect(PromiseTermSchema.safeParse({ promiserID: 1, recipientID: 3, promiseType: 'MILITARY' }).success).toBe(true);
  });

  it('derives TARGETED / SYMMETRIC sets from the metadata flags', () => {
    expect([...TARGETED_PROMISE_TYPES].sort()).toEqual(
      PROMISE_TYPES.filter((t) => PROMISE_METADATA[t].targeted).sort()
    );
    expect([...TARGETED_PROMISE_TYPES]).toEqual(['COOP_WAR']);
    expect([...SYMMETRIC_PROMISE_TYPES]).toEqual(['COOP_WAR']);
  });

  it('derives each promise duration from the metadata durationKey', () => {
    const durations = {
      militaryPromiseDuration: 20,
      expansionPromiseDuration: 50,
      borderPromiseDuration: 50,
      coopWarPromiseDuration: 10,
    };
    expect(durationForPromiseType('MILITARY', durations)).toBe(20);
    expect(durationForPromiseType('COOP_WAR', durations)).toBe(10);
    // No durationKey ⇒ binds indefinitely (no fallback to the deal duration).
    expect(durationForPromiseType('NO_DIGGING', { ...durations, defaultDuration: 30 })).toBeUndefined();
  });
});

describe('symmetrizeDeal', () => {
  it('appends the opposite-direction twin for a one-sided mutual agreement', () => {
    const out = symmetrizeDeal(deal([{ fromPlayerID: 1, toPlayerID: 3, itemType: 'DECLARATION_OF_FRIENDSHIP' }]));
    expect(out.items).toEqual([
      { fromPlayerID: 1, toPlayerID: 3, itemType: 'DECLARATION_OF_FRIENDSHIP' },
      { fromPlayerID: 3, toPlayerID: 1, itemType: 'DECLARATION_OF_FRIENDSHIP' },
    ]);
  });

  it('is idempotent — an already-symmetric pact is returned unchanged (same reference)', () => {
    const input = deal([
      { fromPlayerID: 1, toPlayerID: 3, itemType: 'DEFENSIVE_PACT' },
      { fromPlayerID: 3, toPlayerID: 1, itemType: 'DEFENSIVE_PACT' },
    ]);
    const out = symmetrizeDeal(input);
    expect(out).toBe(input);
    expect(out.items).toHaveLength(2);
  });

  it('leaves directional items (gold, open borders) untouched', () => {
    const input = deal([
      { fromPlayerID: 1, toPlayerID: 3, itemType: 'GOLD', amount: 50 },
      { fromPlayerID: 1, toPlayerID: 3, itemType: 'OPEN_BORDERS' },
    ]);
    const out = symmetrizeDeal(input);
    expect(out).toBe(input);
    expect(out.items).toHaveLength(2);
  });

  it('completes multiple distinct pacts in one pass without mutating the input', () => {
    const input = deal([
      { fromPlayerID: 1, toPlayerID: 3, itemType: 'PEACE_TREATY' },
      { fromPlayerID: 1, toPlayerID: 3, itemType: 'RESEARCH_AGREEMENT' },
    ]);
    const out = symmetrizeDeal(input);
    expect(input.items).toHaveLength(2); // input not mutated
    expect(out.items).toHaveLength(4);
    expect(out.items).toEqual(expect.arrayContaining([
      { fromPlayerID: 3, toPlayerID: 1, itemType: 'PEACE_TREATY' },
      { fromPlayerID: 3, toPlayerID: 1, itemType: 'RESEARCH_AGREEMENT' },
    ]));
  });

  it('mirrors a one-sided Coop War promise into the opposite-directed twin (same target)', () => {
    const out = symmetrizeDeal(promiseDeal([{ promiserID: 1, recipientID: 3, promiseType: 'COOP_WAR', targetPlayerID: 9 }]));
    expect(out.promises).toEqual([
      { promiserID: 1, recipientID: 3, promiseType: 'COOP_WAR', targetPlayerID: 9 },
      { promiserID: 3, recipientID: 1, promiseType: 'COOP_WAR', targetPlayerID: 9 },
    ]);
  });

  it('is idempotent for an already-symmetric Coop War pair (same reference)', () => {
    const input = promiseDeal([
      { promiserID: 1, recipientID: 3, promiseType: 'COOP_WAR', targetPlayerID: 9 },
      { promiserID: 3, recipientID: 1, promiseType: 'COOP_WAR', targetPlayerID: 9 },
    ]);
    expect(symmetrizeDeal(input)).toBe(input);
  });

  it('leaves a non-mutual promise (Military) directional', () => {
    const input = promiseDeal([{ promiserID: 1, recipientID: 3, promiseType: 'MILITARY' }]);
    expect(symmetrizeDeal(input)).toBe(input);
  });
});

describe('applyDealDurations (promises)', () => {
  const durations = { defaultDuration: 30, militaryPromiseDuration: 20, coopWarPromiseDuration: 10 };

  it('stamps the fixed game duration onto promises that carry one', () => {
    const out = applyDealDurations(promiseDeal([
      { promiserID: 1, recipientID: 3, promiseType: 'MILITARY' },
      { promiserID: 1, recipientID: 3, promiseType: 'COOP_WAR', targetPlayerID: 9 },
    ]), durations);
    expect(out.promises[0]).toMatchObject({ promiseType: 'MILITARY', duration: 20 });
    expect(out.promises[1]).toMatchObject({ promiseType: 'COOP_WAR', duration: 10 });
  });

  it('does not stamp a duration (nor inherit the deal duration) on an indefinite promise, and strips a stray one', () => {
    const out = applyDealDurations(promiseDeal([
      { promiserID: 1, recipientID: 3, promiseType: 'NO_DIGGING', duration: 99 } as PromiseTerm,
    ]), durations);
    expect(out.promises[0].duration).toBeUndefined();
  });
});
