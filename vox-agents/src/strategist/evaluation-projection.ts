/** Provider-independent, read-only projection of perspective-bound strategic evidence. */
import type { GameState, StrategistParameters } from './strategy-parameters.js';

type RecordValue = Record<string, unknown>;
type Issues = { missing: string[]; stale: string[]; incomplete: string[]; truncated: string[]; excluded: string[] };
type Interval = { after: number; before: number };

/** Fixed output limits; this stage does not add runtime configuration or a routing policy. */
export const strategicProjectionLimits = { text: 512, name: 96, list: 16, events: 24, eventText: 512, gaps: 16 } as const;

/** Treat only plain JSON records as structured evidence. */
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

/** Accept finite observed quantities without manufacturing a missing zero. */
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Accept only nonnegative integer turns and event IDs. */
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Add a bounded, machine-readable limitation once per section. */
function issue(issues: Issues, kind: keyof Issues, section: string): void {
  if (!issues[kind].includes(section)) issues[kind].push(section);
}

/** Bound untrusted text as a data value, retaining an explicit truncation flag. */
function text(value: unknown, section: string, issues: Issues, limit: number = strategicProjectionLimits.text): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > limit) issue(issues, 'truncated', section);
  return value.slice(0, limit);
}

/** Keep a deterministic prefix of names from either arrays or named option dictionaries. */
function names(value: unknown, section: string, issues: Issues): string[] | null {
  const dictionary = record(value);
  const values = Array.isArray(value) ? value : dictionary ? Object.keys(dictionary).sort() : undefined;
  if (!values) { issue(issues, 'missing', section); return null; }
  if (values.length > strategicProjectionLimits.list) issue(issues, 'truncated', section);
  return values.slice(0, strategicProjectionLimits.list).flatMap(value => {
    const name = text(value, section, issues, strategicProjectionLimits.name);
    if (name === null) issue(issues, 'incomplete', section);
    return name === null ? [] : [name];
  });
}

/** Reject unknown, foreign, and future live observations before copying any payload. */
function sourceTurn(value: unknown, parameters: StrategistParameters, section: string, issues: Issues): number | null {
  const source = record(value);
  if (!source || !integer(source.Turn)) {
    issue(issues, 'missing', `${section}.source`);
    return null;
  }
  if (source.GameID !== parameters.gameID || source.PlayerID !== parameters.playerID || source.Turn > parameters.turn) {
    issue(issues, 'excluded', section);
    return null;
  }
  if (source.Turn < parameters.turn) issue(issues, 'stale', section);
  return source.Turn;
}

/** Validate the separately dated saved decision rather than assigning it the live options turn. */
function savedDecision(value: unknown, parameters: StrategistParameters, section: string, issues: Issues): RecordValue | undefined {
  const decision = record(value);
  if (!decision || !integer(decision.UpdatedTurn)) {
    issue(issues, 'missing', `${section}.recordedTurn`);
    return undefined;
  }
  if (decision.UpdatedTurn > parameters.turn) {
    issue(issues, 'excluded', section);
    return undefined;
  }
  return decision;
}

/** Copy only the requesting player's dated scalar facts, never the other-player dictionary. */
function ownFacts(state: GameState | undefined, parameters: StrategistParameters, issues: Issues) {
  const own = record(state?.players?.[String(parameters.playerID)]);
  const turn = sourceTurn(own?.Source, parameters, 'ownState', issues);
  if (turn === null || !own) return null;
  return {
    observedTurn: turn,
    gold: number(own.Gold), goldPerTurn: number(own.GoldPerTurn),
    happinessPercentage: number(own.HappinessPercentage), cities: number(own.Cities), population: number(own.Population),
    militaryUnits: number(own.MilitaryUnits), militarySupply: number(own.MilitarySupply),
    sciencePerTurn: number(own.SciencePerTurn), culturePerTurn: number(own.CulturePerTurn),
    currentResearch: text(own.CurrentResearch, 'ownState', issues), nextPolicyTurns: number(own.NextPolicyTurns),
  };
}

/** Compute unqueried ID ranges without enumerating every skipped turn. */
function uncovered(intervals: Interval[], after: number, before: number): Interval[] {
  const gaps: Interval[] = [];
  let cursor = after;
  for (const interval of intervals.sort((a, b) => a.after - b.after || b.before - a.before)) {
    if (interval.before <= cursor || interval.after >= before) continue;
    if (interval.after > cursor) gaps.push({ after: cursor, before: Math.min(interval.after, before) });
    cursor = Math.max(cursor, interval.before);
  }
  if (cursor < before) gaps.push({ after: cursor, before });
  return gaps;
}

/** Omit resource annotations whose redaction used a newer, separately read player summary. */
function eventEvidence(value: unknown, issues: Issues): unknown {
  if (Array.isArray(value)) return value.map(item => eventEvidence(item, issues));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).flatMap(([key, item]) => {
    if (/resource/i.test(key)) { issue(issues, 'incomplete', 'events.resource-details'); return []; }
    return [[key, eventEvidence(item, issues)]];
  }));
}

/** Read immutable slices, preserving the whole requested window even when rendered details are bounded. */
function projectEvents(parameters: StrategistParameters, fromTurn: number, issues: Issues) {
  const after = fromTurn * 1_000_000;
  const before = Math.min(parameters.before, parameters.turn * 1_000_000 + 999_999);
  const intervals: Interval[] = [];
  const items: { turn: number; type: string; details: string }[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  const states = Object.values(parameters.gameStates).filter(state => integer(state.turn) && state.turn <= parameters.turn).sort((a, b) => a.turn - b.turn);
  for (const state of states) {
    if (fromTurn > parameters.turn) break;
    const perspective = state.eventsPerspective;
    if (perspective?.gameID !== parameters.gameID || perspective.playerID !== parameters.playerID
      || !integer(state.eventsAfter) || !integer(state.eventsBefore) || state.eventsBefore < state.eventsAfter || !state.events) continue;
    const report = record(state.events);
    if (!report) continue;
    const original = Array.isArray(report.events);
    // A consolidated report has no IDs, so it cannot be trimmed within its last turn.
    if (!original && state.eventsBefore > before && before % 1_000_000 !== 999_999) {
      issue(issues, 'excluded', 'events.upper-bound');
      continue;
    }
    const groups = original ? [['original', report.events as unknown[]] as const]
      : Object.entries(report).filter(([key]) => key !== '_markdownConfig');
    let valid = true;
    for (const [key, group] of groups) {
      if (!Array.isArray(group) || (key !== 'original' && !/^\d+$/.test(key))) { valid = false; continue; }
      for (const value of group) {
        const event = record(value);
        if (!event) { valid = false; continue; }
        const turn = key === 'original' ? event.Turn : Number(key);
        if (!integer(turn) || (original && (!integer(event.ID) || Math.floor(event.ID / 1_000_000) !== turn))) { valid = false; continue; }
        if (turn < fromTurn || turn > parameters.turn) continue;
        if (integer(event.ID) && (event.ID <= Math.max(after, state.eventsAfter) || event.ID > Math.min(before, state.eventsBefore))) continue;
        if (typeof event.Type !== 'string') { valid = false; continue; }
        // Consolidation removes IDs. Collapse identical rendered entries, not claimed unique game events.
        const serialized = JSON.stringify(eventEvidence(event, issues));
        const fingerprint = `${turn}:${serialized}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        if (items.length >= strategicProjectionLimits.events) { omitted++; continue; }
        items.push({ turn, type: text(event.Type, 'events', issues, strategicProjectionLimits.name) ?? '', details: text(serialized, 'events', issues, strategicProjectionLimits.eventText) ?? '' });
      }
    }
    if (valid) intervals.push({ after: state.eventsAfter, before: state.eventsBefore });
    else issue(issues, 'incomplete', 'events.shape');
  }
  const empty = fromTurn > parameters.turn;
  const gaps = empty ? [] : uncovered(intervals, after, before);
  const validWindow = integer(before) && before >= after;
  if (!empty && !validWindow) issue(issues, 'incomplete', 'events.window');
  if (gaps.length) issue(issues, 'incomplete', 'events.coverage');
  if (omitted || gaps.length > strategicProjectionLimits.gaps) issue(issues, 'truncated', 'events');
  return { fromTurn, toTurn: parameters.turn, after, before, empty, coverageComplete: empty || (validWindow && gaps.length === 0), uncovered: gaps.slice(0, strategicProjectionLimits.gaps), omittedRanges: Math.max(0, gaps.length - strategicProjectionLimits.gaps), omittedEntries: omitted, items };
}

/** Build bounded evaluator data without tool calls, cache writes, event consumption, or route selection. */
export function projectStrategicEvaluation(parameters: StrategistParameters) {
  const issues: Issues = { missing: [], stale: [], incomplete: [], truncated: [], excluded: [] };
  const state = Object.values(parameters.gameStates).filter(state => integer(state.turn) && state.turn <= parameters.turn)
    .sort((a, b) => b.turn - a.turn)[0];
  if (!state) issue(issues, 'missing', 'snapshot');
  else if (state.turn < parameters.turn) issue(issues, 'stale', 'snapshot');
  const optionsTurn = sourceTurn(state?.options?.Source, parameters, 'options', issues);
  const options = optionsTurn === null ? undefined : state?.options;
  const strategy = savedDecision(options?.Strategy, parameters, 'plan', issues);
  const research = savedDecision(options?.Technology, parameters, 'research', issues);
  const policy = savedDecision(options?.Policy, parameters, 'policy', issues);
  const ownState = ownFacts(state, parameters, issues);
  const lastTurn = integer(parameters.lastDecisionTurn) && parameters.lastDecisionTurn <= parameters.turn ? parameters.lastDecisionTurn : null;
  if (lastTurn === null) issue(issues, 'missing', 'lastDecision');
  // The same table also contains native-AI updates carrying an older explanation.
  // Its record turn cannot establish authorship or association with the last model decision.
  issue(issues, 'missing', 'lastDecision.rationale');
  const flavorEntries = Object.entries(record(strategy?.Flavors) ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (flavorEntries.length > strategicProjectionLimits.list) issue(issues, 'truncated', 'plan.flavors');
  const plan = strategy ? {
    recordedTurn: strategy.UpdatedTurn as number,
    grandStrategy: text(strategy.GrandStrategy, 'plan', issues),
    economicStrategies: names(strategy.EconomicStrategies, 'plan', issues),
    militaryStrategies: names(strategy.MilitaryStrategies, 'plan', issues),
    flavors: flavorEntries.slice(0, strategicProjectionLimits.list).map(([key, value]) => ({ name: text(key, 'plan', issues, strategicProjectionLimits.name), value: number(value) })),
    rationale: { kind: 'untrusted-text' as const, authorship: 'unknown' as const, text: text(strategy.Rationale, 'plan.rationale', issues) },
  } : null;
  // Availability and estimates are evidence, not proof of a mandatory choice or an engine deadline.
  const choices = {
    observedTurn: optionsTurn,
    research: { available: names(options?.Options?.Technologies, 'choices.research', issues), selected: research ? text(research.Next, 'research', issues) : null, recordedTurn: research ? research.UpdatedTurn as number : null },
    policy: { available: names(options?.Options?.Policies, 'choices.policy', issues), selected: policy ? text(policy.Next, 'policy', issues) : null, recordedTurn: policy ? policy.UpdatedTurn as number : null, estimatedAvailableInTurns: ownState?.nextPolicyTurns ?? null, estimateObservedTurn: ownState?.observedTurn ?? null },
    mandatory: 'unknown' as const,
    deadlines: 'unknown' as const,
  };
  issue(issues, 'incomplete', 'mandatory-choices-and-deadlines');
  const baseline = lastTurn === null ? null : ownFacts(parameters.gameStates[lastTurn], { ...parameters, turn: lastTurn }, { missing: [], stale: [], incomplete: [], truncated: [], excluded: [] });
  const deltas: Record<string, number> = {};
  if (baseline && ownState && baseline.observedTurn === lastTurn && ownState.observedTurn >= baseline.observedTurn) {
    for (const key of ['gold', 'goldPerTurn', 'happinessPercentage', 'cities', 'population', 'militaryUnits', 'militarySupply'] as const) {
      const previous = baseline[key]; const current = ownState[key];
      if (previous !== null && current !== null) deltas[key] = current - previous;
    }
  } else issue(issues, 'missing', 'changes.baseline');
  const events = projectEvents(parameters, lastTurn === null ? parameters.turn : lastTurn + 1, issues);
  return {
    version: 1 as const,
    identity: { gameID: parameters.gameID, playerID: parameters.playerID, turn: parameters.turn },
    snapshot: { cacheTurn: state?.turn ?? null },
    sources: { ownState: 'get-players', planAndChoices: 'get-options', events: 'get-events' } as const,
    plan,
    lastDecision: { turn: lastTurn, rationale: null },
    ownState, choices, changes: { sinceTurn: lastTurn, observedTurn: ownState?.observedTurn ?? null, deltas },
    risks: { assessment: 'unknown' as const }, events, limitations: issues,
  };
}

export type StrategicEvaluationInput = ReturnType<typeof projectStrategicEvaluation>;
