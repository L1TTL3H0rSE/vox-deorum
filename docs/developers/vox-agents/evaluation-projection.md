# Strategic evaluation input

`projectStrategicEvaluation` in `vox-agents/src/strategist/evaluation-projection.ts` builds a typed, provider-independent data object from `StrategistParameters`. It is a pure reader of the existing cache. It does not call tools or models, select a route, or change pacing. No production hook invokes it yet.

The exported `StrategicEvaluationInput` has a version, game/player/target-turn identity, source names, and the following evidence sections. All names, explanations, and event details are untrusted data. Explanations are never engine guarantees.

| Section | Source | Visibility and time boundary |
| --- | --- | --- |
| Own economy and military totals | Requesting player's row from `get-players` | Copies a fixed scalar allowlist only. Other players, rankings, intelligence and defeated-player labels are omitted. The row's Source identifies the game, viewer and Lua observation turn. |
| Current recorded plan and explanation | `get-options.Strategy` | The endpoint selects the requesting player's StrategyChanges or FlavorChanges record. UpdatedTurn is a database record date, not proof of model authorship or a live observation date. |
| Last decision | `lastDecisionTurn` | Carries the existing seat-local decision marker. Rationale attribution stays unknown: native AI can update a strategy record while preserving an older explanation. |
| Research and policy choices | `get-options.Options`, Technology and Policy | Uses only the requesting player's options. Saved selections carry their record dates; available choices use the live options observation. `NextPolicyTurns` from own-state is an estimate. |
| Changes | Own-state at the last decision and the selected current snapshot | Deltas require an exact baseline observation at the last decision and a current observation at least as recent. Missing observations never become zero. |
| Events | Immutable cached `get-events` slices | The MCP query applies the viewer visibility flags and exclusive After/inclusive Before bounds. It rejects a requested GameID mismatch or a game switch during the read. Row ID/Turn/Type take precedence over payload keys. |

`get-player-summary.lua` and `get-player-options.lua` capture `Game.GetGameTurn()` in the returned rows. `get-options` completes its saved/fallback reads before its existing live options call. The latter observation therefore bounds the earlier reads under monotonic time in one game, even when the server's event-processing turn lags. Source time is not inferred from the requested turn. Both reports reject a game switch across their reads.

The projector selects the latest cached snapshot no later than the target. It excludes report contents when source identity/time is unknown, belongs to another game/player, or is later than the target. An older observation is marked stale. Saved records with missing or future record dates are excluded separately. The output is not an atomic historical snapshot, and same-game save rewinds require the existing session cache to be reset by its owner.

## Incomplete evidence

The current reports do not establish mandatory engine choices, hard deadlines, or an exhaustive threat assessment. These fields explicitly remain `unknown`. Available policies, technologies and estimates are retained separately from event details, including a zero-turn policy estimate on a quiet turn. They are not promoted to hard constraints.

Plan explanations are marked as untrusted text with unknown authorship. They may contain model text retained or wrapped by the native AI. A matching database turn alone cannot identify the rationale of the last completed strategic decision.

The event tool redacts resource annotations using a separately fetched current player summary. The projection therefore removes resource fields recursively and reports the omission, avoiding later resource knowledge in an older projected input. It does not reconstruct historical visibility or copy cities, military reports, victory standings, arbitrary working memory, or generated briefings.

Every absent, stale, incomplete, truncated or excluded section has an explicit limitation or a null value. Consumers must not interpret missing evidence, an empty event prefix, or unknown risks as permission to skip a decision. Route and fallback policy belong to a later change.

## Event windows and limits

Events span the turn after the last completed decision through the target turn. Without a decision marker, the window starts at the target turn. A decision already completed this turn gives an empty window. The upper ID bound also respects the current request's Before value.

Refresh records the perspective and exact ID bounds of the retained event slice. A narrower same-turn refresh cannot relabel the older, wider slice. Legacy slices without provenance cannot prove coverage. The projector reads `events`, never the potentially shortened `mergedEvents`, and does not consume or mutate either. Missing or culled slices produce explicit uncovered ID ranges. Malformed slices cannot prove coverage.

`coverageComplete` describes query-range coverage only. It does not promise complete rendered detail, historical visibility, or absence of threats. Consolidated entries lack individual IDs; a report extending past a partial-turn Before bound is excluded because it cannot be trimmed safely. Identical rendered entries are deduplicated, so entry counts are not counts of unique game events.

`strategicProjectionLimits` keeps at most 24 event entries, 512 characters of each detail/explanation, 96 characters per name, 16 names/flavors per section and 16 uncovered ranges. Event entries follow cached-turn and report order; option dictionary keys are sorted. Omitted entries/ranges have counts and truncated sections are flagged. Structured choices have their own limits and cannot be displaced by event volume. Output does not grow with the number of cached turns or events, apart from the canonical game identity. This is a character bound, not a tokenizer-specific token budget.

## Verification and next integration point

Mock tests exercise report getters, real SQLite visibility queries through an MCP client, `refreshGameState`, and the projector. They cover game/player/time exclusion, event payload identity, skipped turns and gaps, stale baselines, truncated input, quiet choices, and repeated immutable reads. Lua responses are simulated; these tests do not execute Civilization V or validate model decisions.

The existing `createTriage` projectState hook can consume this object when a later change defines questions, fallback rules and pacing integration. This helper does not install that hook or depend on any specific evaluation provider.
