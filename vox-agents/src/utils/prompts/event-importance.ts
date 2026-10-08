/**
 * @module utils/prompts/event-importance
 *
 * Importance-based trimming for turn-keyed event reports. Event types are grouped into tiers,
 * from most to least important. Unlisted types count as noise. When a report is too large,
 * callers drop the least important tier, check the size again, and continue one tier at a time.
 * The top tier is never dropped.
 */

/**
 * Event types grouped by importance, most important first. Unlisted types belong to the noise
 * tier. Events blocked by the DLL's forwarding blacklist are omitted.
 */
export const eventImportanceTiers: readonly (readonly string[])[] = [
  // Turning points: war and peace, conquest, deals, messages, and ideology.
  [
    "DeclareWar", "MakePeace", "NuclearDetonation", "CityCaptureComplete", "CityRazed", "CityPuppeted",
    "CityFlipped", "PlayerLiberated", "CapitalChanged", "RelayedMessage", "DiplomaticMessage", "DealMade",
    "IdeologyAdopted", "IdeologySwitched", "ResolutionResult", "ReligionFounded", "PlayerAnarchy",
  ],
  // Diplomatic and strategic shifts.
  [
    "TeamMeet", "SetAlly", "MinorAlliesChanged", "UiDiploEvent", "ElectionResultSuccess", "ElectionResultFailure",
    "PlayerBullied", "PlayerGifted", "PlayerProtected", "PlayerRevoked", "PlayerBoughtOut",
    "PlayerPlunderedTradeRoute", "StealPlot", "PlayerAdoptsGovernment", "PlayerSecularizes", "StateReligionAdopted",
    "StateReligionChanged", "UnitCityFounded", "PlayerGoldenAge", "LoyaltyStateChanged", "CircumnavigatedGlobe",
  ],
  // Progress: policies, technologies, wonders, great people, religion, and city-state relations.
  [
    "PlayerAdoptPolicy", "TeamTechResearched", "PlayerBuilt", "CityConstructed",
    "CityProjectComplete", "GreatPersonExpended", "GreatWorkCreated", "PantheonFounded", "ReligionEnhanced",
    "ReligionReformed", "CityConvertsReligion", "CityConvertsPantheon", "PlayerAdoptsCurrency", "ProvinceLevelChanged",
    "ContractStarted", "ContractEnded", "ContractsRefreshed", "MinorFriendsChanged", "EspionageState",
    "EspionageNotificationData", "MinorGift", "MinorGiftUnit", "NaturalWonderDiscovered", "PlayerTradeRouteCompleted",
    "GovernmentCooldownChanges", "GovernmentCooldownRateChanges", "ReformCooldownChanges", "ReformCooldownRateChanges",
    "PlayerEndOfMayaLongCount", "GoodyHutTechResearched",
  ],
  // Military detail: combat, units, and barbarians.
  [
    "CombatResult", "UnitKilledInCombat", "UnitCaptured", "CityTrained", "UnitCreated",
    "EventUnitCreated", "UnitPromoted", "UnitUpgraded", "UnitConverted", "CityInvestedUnit", "ParadropAt",
    "BarbariansCampCleared", "BarbariansCampFounded",
  ],
  // Economy detail: city growth, purchases, and city events.
  [
    "SetPopulation", "CityCreated", "CityBoughtPlot", "CityInvestedBuilding", "CitySoldBuilding", "BuildFinished",
    "CityBeginsWLTKD", "CityEndsWLTKD", "CityExtendsWLTKD", "CityEventActivated", "CityEventChoiceActivated",
    "CityEventChoiceEnded", "EventActivated", "EventChoiceActivated", "EventChoiceEnded",
    "ChangeGoldenAgeProgressMeter", "PietyChanged", "PietyRateChanged", "GoodyHutReceivedBonus", "PlaceResource",
    "PlayerBuilding", "TileOwnershipChanged",
  ],
  // Noise: tiles, unit movement, remaining system events, and all unlisted types.
  [
    "TileFeatureChanged", "TileImprovementChanged", "TileRouteChanged", "TileRevealed", "TerraformingMap",
    "UnitSetXY", "RebaseTo", "PushingMissionTo", "PlayerDoTurn", "PlayerDoneTurn", "TeamSetEra", "TurnComplete",
  ],
];

/**
 * The deepest trim level: every tier except the top one. Level 1 drops noise, including unlisted
 * types, and each further level drops one more tier, starting from the least important.
 */
export const maxEventTrimLevel = eventImportanceTiers.length - 1;

/** Tier index by event type. */
const tierByType = new Map(eventImportanceTiers.flatMap((tier, index) => tier.map(type => [type, index] as const)));

/** Rank one event by its tier, treating unlisted or missing types as noise. */
function eventRank(event: unknown): number {
  const type = (event as { Type?: unknown } | null)?.Type;
  return typeof type === "string" ? tierByType.get(type) ?? maxEventTrimLevel : maxEventTrimLevel;
}

/** A trimmed copy of an events report and how many events it lost. */
export interface TrimmedEvents<T> {
  /** The events report with the dropped events removed. */
  events: T;
  /** How many trim levels were applied (0 when nothing was dropped). */
  droppedTiers: number;
  /** How many events were removed. */
  droppedEvents: number;
}

/**
 * Copy a turn-keyed events report without its `level` least important groups (see
 * {@link maxEventTrimLevel}). Non-array entries such as `_markdownConfig` are kept, and turns
 * left without events are removed. Level 0 returns an unchanged copy.
 *
 * @param events - The turn-keyed events report
 * @param level - How many importance groups to drop, from 0 to {@link maxEventTrimLevel}
 * @returns The trimmed copy and the number of events removed
 */
export function dropLeastImportantEvents<T extends object>(events: T, level: number): TrimmedEvents<T> {
  const keepBelow = eventImportanceTiers.length - Math.min(Math.max(level, 0), maxEventTrimLevel);
  const trimmed: Record<string, unknown> = {};
  let droppedEvents = 0;
  for (const [key, value] of Object.entries(events)) {
    if (!Array.isArray(value)) {
      trimmed[key] = value;
      continue;
    }
    const kept = value.filter(event => eventRank(event) < keepBelow);
    droppedEvents += value.length - kept.length;
    if (kept.length > 0) trimmed[key] = kept;
  }
  return { events: trimmed as T, droppedTiers: droppedEvents > 0 ? level : 0, droppedEvents };
}

/**
 * Drop the least important events until `fits` accepts the report, starting with noise (including
 * unlisted types) and checking after each tier. Levels that would drop nothing new are skipped.
 * Stops with only the top tier left; the result then reports `fits: false`.
 *
 * @param events - The turn-keyed events report
 * @param fits - Whether a candidate report is small enough
 * @returns The first candidate that fits, or the most trimmed one
 */
export function trimEventsToFit<T extends object>(
  events: T,
  fits: (candidate: T) => boolean,
): TrimmedEvents<T> & { fits: boolean } {
  let last: TrimmedEvents<T> = { events, droppedTiers: 0, droppedEvents: 0 };
  if (fits(events)) return { ...last, fits: true };
  for (let level = 1; level <= maxEventTrimLevel; level++) {
    const candidate = dropLeastImportantEvents(events, level);
    if (candidate.droppedEvents === last.droppedEvents) continue;
    last = candidate;
    if (fits(candidate.events)) return { ...candidate, fits: true };
  }
  return { ...last, fits: false };
}
