/**
 * Tests for importance-based event trimming (src/utils/prompts/event-importance.ts): the explicit
 * tier table lists no type twice, `dropLeastImportantEvents` removes one importance group per
 * level from the least important end (unlisted, missing, and non-string types count as noise, so
 * level 1 drops them together with the noise tier and the top tier is last), and
 * `trimEventsToFit` walks those levels until a caller-supplied size check accepts the report.
 */
import { describe, expect, it } from 'vitest';
import {
  dropLeastImportantEvents,
  eventImportanceTiers,
  maxEventTrimLevel,
  trimEventsToFit,
} from '../../../src/utils/prompts/event-importance.js';

/** A type no tier lists, so it counts as noise and drops with the least important tier. */
const unknownType = 'TypeNotInAnyTier';

/** The first type of every tier, most important first. */
const tierLeaders = eventImportanceTiers.map(tier => tier[0]);

/** The least important tier's type: dropped together with unknown types at level 1. */
const noiseType = tierLeaders[tierLeaders.length - 1];

/** One event of a type, shaped like a consolidated `get-events` entry. */
function event(type: string): { Type: string } {
  return { Type: type };
}

/** A single-turn report holding one event of each given type. */
function reportOf(types: string[]): Record<string, unknown[]> {
  return { '5': types.map(event) };
}

/** The event types a trimmed report still holds, in report order. */
function keptTypes(events: Record<string, unknown[]>): string[] {
  return Object.values(events).flat().map(entry => (entry as { Type: string }).Type);
}

/** The total number of events in a report. */
function countEvents(events: Record<string, unknown[]>): number {
  return Object.values(events).reduce((total, list) => total + list.length, 0);
}

describe('eventImportanceTiers', () => {
  it('should list each explicit type in no more than one tier', () => {
    const listed = new Set<string>();
    for (const tier of eventImportanceTiers) {
      for (const type of tier) {
        expect(listed.has(type), `${type} listed twice`).toBe(false);
        listed.add(type);
      }
    }
  });

  it('should allow trimming past every tier except the top one', () => {
    expect(maxEventTrimLevel).toBe(eventImportanceTiers.length - 1);
  });
});

describe('dropLeastImportantEvents', () => {
  it('should copy the report unchanged at level 0', () => {
    const events = reportOf([...tierLeaders, unknownType]);

    const result = dropLeastImportantEvents(events, 0);

    expect(result.events).toEqual(events);
    expect(result.events).not.toBe(events);
    expect(result.droppedEvents).toBe(0);
    expect(result.droppedTiers).toBe(0);
  });

  it('should drop the noise tier together with unknown types at level 1', () => {
    const events = reportOf([...tierLeaders, unknownType]);

    const result = dropLeastImportantEvents(events, 1);

    expect(keptTypes(result.events)).toEqual(tierLeaders.slice(0, -1));
    expect(result.droppedEvents).toBe(2);
    expect(result.droppedTiers).toBe(1);
  });

  it('should drop one more tier per level, from the least important end', () => {
    const events = reportOf(tierLeaders);

    for (let level = 1; level <= maxEventTrimLevel; level++) {
      const kept = tierLeaders.slice(0, eventImportanceTiers.length - level);
      const result = dropLeastImportantEvents(events, level);

      expect(keptTypes(result.events), `level ${level}`).toEqual(kept);
      expect(result.droppedEvents, `level ${level}`).toBe(tierLeaders.length - kept.length);
    }
  });

  it('should treat missing and non-string Type values as noise', () => {
    const events = {
      '5': [event(tierLeaders[0]), event(noiseType), event(unknownType), { Type: 42 }, {}],
    };

    // Nothing is special at level 0: the malformed entries ride along.
    expect(countEvents(dropLeastImportantEvents(events, 0).events)).toBe(5);

    // Level 1 removes them with the noise tier and the unknown type, keeping only the top tier.
    const result = dropLeastImportantEvents(events, 1);

    expect(keptTypes(result.events)).toEqual([tierLeaders[0]]);
    expect(result.droppedEvents).toBe(4);
  });

  it('should keep the top tier at the deepest level and clamp levels outside the range', () => {
    const events = reportOf([...tierLeaders, unknownType]);

    const deepest = dropLeastImportantEvents(events, maxEventTrimLevel);
    expect(keptTypes(deepest.events)).toEqual([tierLeaders[0]]);
    expect(deepest.droppedEvents).toBe(tierLeaders.length);

    // Levels beyond the deepest one trim no further than the deepest.
    expect(keptTypes(dropLeastImportantEvents(events, maxEventTrimLevel + 3).events)).toEqual([tierLeaders[0]]);
    // Negative levels drop nothing.
    expect(keptTypes(dropLeastImportantEvents(events, -2).events)).toEqual(keptTypes(events));
  });

  it('should keep non-array entries such as the markdown config at every level', () => {
    const markdownConfig = { configs: [{ format: 'Turn {key}' }] };
    const events = { '5': [...tierLeaders, unknownType].map(event), _markdownConfig: markdownConfig };

    for (const level of [1, 3, maxEventTrimLevel]) {
      const trimmed = dropLeastImportantEvents(events, level).events;
      expect(trimmed._markdownConfig, `level ${level}`).toEqual(markdownConfig);
      expect(trimmed['5'].length, `level ${level}`).toBeGreaterThan(0);
    }
  });

  it('should remove turns left without events and keep the others', () => {
    const events = {
      '3': [event(noiseType)],
      '4': [event(unknownType)],
      '5': [event(tierLeaders[0])],
    };

    // One level empties the noise turn and the unknown-type turn together.
    const result = dropLeastImportantEvents(events, 1);

    expect(Object.keys(result.events)).toEqual(['5']);
    expect(result.droppedEvents).toBe(2);
  });

  it('should count dropped events across every turn', () => {
    const events = {
      '3': [event(unknownType), event(noiseType), event(tierLeaders[0])],
      '4': [event(noiseType), event(tierLeaders[0])],
    };

    // The level that drops noise also drops the unknown type in the other turn.
    const result = dropLeastImportantEvents(events, 1);

    expect(result.droppedEvents).toBe(3);
    expect(countEvents(result.events)).toBe(2);
  });

  it('should not mutate the report it trims', () => {
    const events = reportOf([...tierLeaders, unknownType]);
    const before = JSON.parse(JSON.stringify(events));

    dropLeastImportantEvents(events, maxEventTrimLevel);

    expect(events).toEqual(before);
  });
});

describe('trimEventsToFit', () => {
  /** A size check expressed as an event-count ceiling. */
  function fitsAtMost(maxEvents: number): (candidate: Record<string, unknown[]>) => boolean {
    return candidate => countEvents(candidate) <= maxEvents;
  }

  it('should return the report untouched when the first check already passes', () => {
    const events = reportOf([...tierLeaders, unknownType]);
    let checks = 0;

    const result = trimEventsToFit(events, candidate => {
      checks++;
      return fitsAtMost(99)(candidate);
    });

    expect(result.fits).toBe(true);
    expect(result.events).toBe(events);
    expect(result.droppedTiers).toBe(0);
    expect(result.droppedEvents).toBe(0);
    expect(checks).toBe(1);
  });

  it('should drop the fewest groups that make the report fit', () => {
    const events = reportOf([tierLeaders[0], tierLeaders[3], noiseType]);

    const result = trimEventsToFit(events, fitsAtMost(2));

    // One level is enough: the noise tier's type is the only event that goes.
    expect(result.fits).toBe(true);
    expect(result.droppedTiers).toBe(1);
    expect(result.droppedEvents).toBe(1);
    expect(keptTypes(result.events)).toEqual([tierLeaders[0], tierLeaders[3]]);
  });

  it('should drop unknown types together with noise, never as a step of their own', () => {
    const events = reportOf([tierLeaders[0], noiseType, unknownType]);
    const candidates: string[][] = [];

    // Accept the first candidate that no longer holds the unknown type.
    const result = trimEventsToFit(events, candidate => {
      const types = keptTypes(candidate);
      candidates.push(types);
      return !types.includes(unknownType);
    });

    // There is no unknown-only candidate: the step that removes the unknown type removes noise
    // in the same level, and that first accepted step already fits.
    expect(result.fits).toBe(true);
    expect(result.droppedTiers).toBe(1);
    expect(result.droppedEvents).toBe(2);
    expect(candidates).toEqual([
      [tierLeaders[0], noiseType, unknownType],
      [tierLeaders[0]],
    ]);
  });

  it('should skip levels that would drop nothing new', () => {
    const events = reportOf([tierLeaders[0], tierLeaders[3], noiseType]);
    let checks = 0;

    const result = trimEventsToFit(events, candidate => {
      checks++;
      return fitsAtMost(1)(candidate);
    });

    // One check for the original report plus one per level that actually changed it: the levels
    // whose tiers hold no event in this report are skipped.
    expect(result.fits).toBe(true);
    expect(result.droppedEvents).toBe(2);
    expect(keptTypes(result.events)).toEqual([tierLeaders[0]]);
    expect(checks).toBe(3);
  });

  it('should report fits false with only the top tier left when nothing fits', () => {
    const events = reportOf([...tierLeaders, unknownType]);
    let checks = 0;

    const result = trimEventsToFit(events, () => {
      checks++;
      return false;
    });

    expect(result.fits).toBe(false);
    expect(keptTypes(result.events)).toEqual([tierLeaders[0]]);
    expect(result.droppedEvents).toBe(tierLeaders.length);
    expect(result.droppedTiers).toBe(maxEventTrimLevel);
    expect(checks).toBe(maxEventTrimLevel + 1);
  });
});
