# Context records: a core prompt plus files

## Overview

Vox Deorum agents will build prompts from a shared set of game information. Each agent chooses a layout: which sections to show, in what order, and with which descriptions or filters.

Without file access, these layouts reproduce today's prompts. With file access, the host also writes game reports to a read-only records folder. The simple strategist keeps a smaller core prompt and reads detailed reports when needed. Other agents keep their current inline information and gain access to the records.

Records preserve the reports from each processed turn, including turns skipped by pacing. Agents can consult earlier turns after they leave the in-memory cache. A static reference supplies technology, policy, building, and unit listings.

Oracle replays use the recorded file-access setting. Each replay gets its own temporary workspace, with factual records through turn T and notes and archived briefings through T-1. Its writes stay inside that replay.

The lifecycle is straightforward: reference setup must succeed before the session runs; record-write failures fail the strategist's turn. Loading an earlier turn deletes excess records. Agent notes survive a reload and may therefore retain knowledge from the discarded future.

Paths below are relative to `vox-agents/src/` unless they start with `vox-agents/`, `mcp-server/`, or `docs/`.

## Goal and success criteria

- Without `files`, refactored builders produce byte-identical `getSystem` and `getInitialMessages` output, make the same MCP calls, and create no records or note archives.
- With `files`, each processed turn is recorded under `<telemetryDir>/workspaces/records/<gameID>-player-<playerID>/` and exposed as `/workspace/records`.
- File-mode layouts are used only by runs that declare `bash`. Restricted runs, such as a live envoy's greeting, keep their inline content.
- The simple strategist moves full players, cities, military, and events out of its prompt. It keeps identity, options, strategies, victory progress, a strategic players summary, and directions to the records.
- Reference initialization failures stop the entire session. Turn-record failures prevent that strategist decision from running with missing data.
- Replay workspaces are independent, use the agreed turn cutoffs, and leave source records and notes unchanged.
- `npm run build:all` and `npm run test:all` pass.

## Current state

| Area | Existing behavior and source |
| --- | --- |
| State collection | `refreshGameState` in `strategist/strategy-parameters.ts` fetches players, events, cities, options, victory progress, and military reports. It updates the seat's cached state in place. |
| Turn processing | `strategist/vox-player.ts` calls `ensureGameState` for every processed turn, then applies pacing and optionally runs the strategist. Chat can refresh uncached state independently. |
| Event windows | `state.events` holds a refresh's event slice. `withEventWindowFallback` builds `state.mergedEvents` for a decision covering several turns and narrows it on context overflow. |
| Briefings | `requestBriefing` in `briefer/briefing-utils.ts` deduplicates generation. Outputs enter `state.reports`; staffed strategists subsequently assemble their own combined briefing there. |
| Prompts | Strategists, briefers, and `buildGameContextMessages` assemble Markdown by hand, using `jsonToMarkdown` and each report's `_markdownConfig`. |
| Workspaces | `utils/workspace/player-workspace.ts` mounts game notes, optional shared folders, and scratch space. Bash output is capped at 8,000 characters per stream. |
| Agent preparation | `infra/vox-execute.ts` prepares system text, initial messages, and run tools in that order. `getRunTools` adds bash to eligible runs; file-enabled contexts already use the files step quota. |
| Session startup | `StrategistSession.handleGameSwitched` creates players, registers tools, and starts their loops. Fatal setup failures must use the session's error path because throwing from a notification handler alone does not stop the session. |
| Oracle | `oracle/retriever.ts` extracts prompts and tools from telemetry. `oracle/replayer.ts` runs rows, models, and repetitions concurrently using schema-only tools, so a recorded bash call currently performs no file operation. |

The six reports already use the seat's perspective through the MCP tools' `PlayerID` auto-completion. Records reuse those results. `get-opinions` and `get-diplomatic-events` add no necessary data beyond the player and event reports.

## Approach

### Shared knowledge and agent layouts

Add a `knowledge/` directory with three small modules:

- `sections.ts` defines the section keys, titles, descriptions, scope, and optional record splitting.
- `knowledge-set.ts` provides `assembleKnowledge(parameters, state)` over existing state and metadata. It separates `Options` from the remaining strategy fields.
- `layout.ts` renders ordered messages made from text parts, section parts, and a records part.

The section keys are `situation`, `civilization`, `options`, `strategies`, `victory`, `players`, `cities`, `military`, `events`, and `briefings`. Situation and civilization are game-scoped; the others are turn-scoped.

A layout message specifies its role, parts, optional cache breakpoint, and separator. A section part can override its heading, description, view, and Markdown configuration. Each part is visible in both modes, inline mode only, or file mode only. The records part appears only in file mode. Rendering preserves message order and existing whitespace, drops empty messages, and applies the requested cache breakpoint.

Keep agent-specific descriptions and filters in their layouts. Share the common game-context layout used by envoys, analysts, and the negotiator. `buildGameContextMessages` continues to default to inline rendering when called without render options. Agent `getSystem` implementations retain their existing resource descriptions.

Use one assembler rather than separate agent variants or separate file-mode prompt builders. The assembly is synchronous and does not fetch data. Reassemble for each prompt attempt so that updated briefings and the selected event window are reflected.

### Events: record the slice, render the decision window

Keep the distinction that already exists in `GameState`. The knowledge set carries the refresh's events and the selected decision events, which default to the refresh's events when no merged window exists. Record writing uses the former; an inline Events section uses the latter.

For example, after a decision on turn 20, pacing skips turns 21 and 22 and the strategist decides on turn 23:

| Consumer | Events |
| --- | --- |
| Turn 21 record | Turn 21's refresh |
| Turn 22 record | Turn 22's refresh |
| Turn 23 record | Turn 23's refresh |
| Turn 23 inline prompt | The selected decision window, initially turns 21-23 |
| Turn 23 file-mode strategist | Directions to the records covering turns 21-23 |

If an inline attempt overflows and retries with turns 22-23, rendering uses that narrower window. The records stay unchanged. A refresh can also cover a dropped turn; its events retain their real turn keys inside the report. No additional event fetching is needed.

### What each agent sees

| Agent | Inline content with files enabled |
| --- | --- |
| Simple strategist | Identity, options, strategies, victory progress, strategic players summary, decision context, and records directions |
| Briefed, staffed, and learned strategists | Today's inline content plus records directions |
| Simple and specialized briefers | Today's inline content plus records directions |
| Shared game-context users: diplomat, spokesperson, diplomatic analyst, negotiator | Today's inline content plus records directions |

`contextLayoutMode(agent, parameters, input, context)` selects file mode when files are enabled and the run's declared tools include bash. An undefined tool list means all registered tools. Otherwise it selects inline mode. The existing deterministic `getRunTools` method can be called during prompt preparation and again by the engine.

The records part names `/workspace/records`, the recorded turn range, the current turn folder, and the record folders covering events since the last completed decision. That event range stays the same even if an inline retry uses a narrower window. It lists moved sections and their file patterns, and points to `CATALOG.md`. Its contents stay fixed during the turn; changing file sizes and newly generated briefings belong in the catalog. This preserves the live envoy's cache boundaries.

Diplomacy background, deals, conversation rows, and historical episode presentation remain in their existing agent contexts. Telepathist and archivist contexts remain without files.

### Records and catalog

Add `SeatRecords` in `knowledge/records.ts`, cached by seat and game on `VoxContext`. Use the existing workspace path validation.

The seat's records folder contains:

| Path | Contents |
| --- | --- |
| `CATALOG.md` | Generated section index, turn ranges, file sizes, and query guidance |
| `game/<key>.md` and `.json` | Situation and civilization, written on the first recorded turn |
| `reference/<kind>.md` and `.json` | Static game listings |
| `turns/<N>/<key>.md` and `.json` | Complete turn reports |
| `turns/<N>/<key>/<part>.md` | Markdown split by civilization, city owner, military zone, or event category |
| `turns/<N>/briefings/<kind>.md` | Generated briefing text |

Markdown uses `jsonToMarkdown` with the source report's rendering configuration and full data. JSON omits `_markdownConfig`. Agent-specific views affect inline rendering only. Split filenames use readable slugs with collision suffixes.

Reports can exceed the bash output cap even after splitting. The catalog explains how to select smaller pieces with `grep`, `head`, `sed -n`, or `jq`. It lists compressed turn ranges, such as `1-40, 42`, and the latest files' sizes.

`recordTurn(knowledge)` writes the factual sections. The knowledge set's briefings section is for inline rendering; `recordBriefing(turn, kind, text)` is the sole writer of archived briefings. It writes the briefer's own output when generation resolves, before a strategist's assembled report can replace it. Repeated writes keep existing files. The catalog is regenerated after writes.

Serialize host writes through a per-seat promise chain and publish files with a temporary file plus rename. Errors propagate to the caller. A record-write failure fails that processed turn, whether pacing would have selected a decision or a skip. The existing turn-error path handles the failure, and the loop can process the next turn. Briefing-write failures propagate through the requesting run as well.

Mount `/workspace/records` read-only whenever files are enabled, including seats without a game-notes mount. Files written after the first bash command must be visible to later commands. Add this folder to the workspace capability instructions and bash mount description.

### Startup reference and loading a game

Initialize records during game setup, after registering the seat's tools and before starting any player loops or autoplay. Prepare every seat first, then start the players.

Each file-enabled seat initializes its reference once per game through four calls:

| Tool | Arguments | Listing contents |
| --- | --- | --- |
| `get-technology` | `MaxResults: 5000`, no search | Names, help, cost, era, and technologies unlocked |
| `get-policy` | `MaxResults: 5000`, no search | Names, help, branch, level, and era |
| `get-building` | `MaxResults: 5000`, no search | Names, help, cost, prerequisite technology, era, and civilization uniqueness |
| `get-unit` | `MaxResults: 5000`, no search | Names, descriptions, combat values, cost, prerequisite technology, era, and civilization uniqueness |

These are listing results, not complete detailed dependency reports. Without files there are no added calls; recording turns and briefings adds no MCP calls.

Create the complete reference in a temporary directory and publish `reference/` after all four calls and their file writes succeed. An existing published reference is reused on a later session. Failed setup is discarded, and any fetch, error result, or write failure stops the entire session through its fatal setup path. Handle both MCP errors and the database tools' returned `Error` field. There is no per-turn reference retry mechanism.

On loading turn N, delete records for N and later, then rebuild the catalog. Turn N will be recorded again from the loaded game. Do this at game initialization, before chats or player loops can write records. Duplicate `recordTurn` calls during normal play simply keep the original files; they do not trigger reload handling.

Cleanup applies to turn records, including their briefings. Both `game/` and `reference/` remain: situation and civilization come from static game settings, and the reference contains static listings. Live agent notes and note snapshots also remain. There is no superseded timeline folder or notes restoration.

### Notes snapshots

After a completed strategist decision on turn N, snapshot the game-notes folder to `<workspaceRoot()>/archives/<gameID>-player-<playerID>/turn-<N>/`, if its contents changed. Hash sorted relative paths and contents to compare with the latest snapshot at or before N. Recompute that comparison from disk after restart.

The label means notes captured after decision N, so replay T selects the latest snapshot at or before T-1. Skipped turns do not snapshot. A repeated decision at N can replace its notes snapshot with the newly captured contents; note snapshots are separate from write-once factual records. A seat without a game-notes mount has no notes to snapshot.

Reloading does not rewind notes or purge their snapshots. Retained notes can contain knowledge from a discarded future, including in snapshots taken after play resumes. This is a documented limitation, not a separate timeline-management feature.

### Telemetry and oracle replay

Record two independent facts on every agent span:

| Attribute | Meaning |
| --- | --- |
| `context.files` | Boolean: file access is enabled on the context |
| `context.layout` | `inline` or `files`: how this run's initial messages were rendered |

For example, a file-enabled envoy greeting records `context.files = true` and `context.layout = inline`, because that run cannot use bash. The retriever carries both fields and the source telemetry root into `RetrievedRow`. Missing fields on older rows default to false and inline. Replay enables file support from `context.files`, not by inspecting prompt text or inferring it from the layout.

Add a shared `Workspace` interface with `exec(command, signal)`. `PlayerWorkspace` implements it. `VoxContext.workspaceFor(parameters)` resolves the normal seat workspace or a workspace supplied for a replay execution. Bash uses that method.

`ReplayWorkspace` owns a unique temporary directory for each replay execution, including each model variant and repetition. Populate it before the first step:

| Virtual path | Replay contents |
| --- | --- |
| `/workspace/records` | Read-only copies of game/reference data and factual turn records through T; archived briefings only through T-1; a catalog generated from those copied files |
| `/workspace/game` | Writable copy of the latest notes snapshot at or before T-1, or empty if none exists |
| `/tmp` | Writable scratch space for this execution |

Copying the selected files keeps filtering simple: turn T's briefing folder is omitted while its factual reports are included. Do not mount the live archive or shared folders. Files written in one bash call persist for the next call in that replay. Dispose of the temporary directory when the execution ends.

Use the existing oracle context for rows with files disabled and a second context with files enabled for the other rows. The file-enabled context uses `config.filesQuota ?? defaultFilesQuota`, schema-only tools, and a real bash tool registered after schema replacement. Keep the original run's declared tool list, so restricted runs do not gain bash just because the replay context has it.

The shared context resolves a separate workspace for each root replay execution, never a workspace cached only by game/player/turn. Give the two contexts distinct identities, register both telemetry outputs under the oracle experiment, and close both during shutdown. Expose both output locations in the replay result logging.

## Implementation steps

### 1. Capture existing prompts

Create a compact recorded game-state fixture under `vox-agents/tests/fixtures/game-state/`, using local telemetry and cached tool definitions. Include metadata with `YouAre`, all six reports, and their Markdown configurations. Keep any capture script local.

Add temporary golden tests under `vox-agents/tests/mock/prompts/` for the four LLM strategists, the simple briefer, all three specialized briefer modes, and `buildGameContextMessages`. Pre-fill briefings, include a past briefing, fix working-memory instructions, and mock episode retrieval. Capture `getSystem` and `getInitialMessages` before refactoring.

### 2. Introduce sections and layouts

Add the knowledge registry, assembler, and renderer. Port each builder while keeping the golden tests unchanged. Preserve the separate turn and decision event inputs, and render each overflow retry from the current selected window.

Keep `buildGameContextMessages` inline by default. Make envoy and analyst context-message helpers async where needed for mode selection. Add the records part to adopting layouts and mark the simple strategist's full reports as inline-only.

### 3. Add records, reference setup, and notes

Implement `SeatRecords`, catalog generation, record splitting, reference publication, load-time pruning, and changed-notes snapshots. Add the cached records accessor and the read-only workspace mount. Update workspace capability instructions and bash descriptions.

In `StrategistSession.handleGameSwitched`, register and prepare all players before launching their execution loops. Run load cleanup and reference initialization here. Route setup failures through the existing fatal session path, including abort and completion signaling; do not rely on an exception escaping a notification callback.

### 4. Connect turn and briefing hooks

- After `ensureGameState` in `vox-player.ts`, record each processed turn when files are enabled, before pacing can skip or the strategist can run.
- After a completed decision, snapshot changed notes using that decision's turn number.
- In `requestBriefing`, await recording of a newly generated output. Propagate write failures instead of treating them as an unavailable briefing.
- Leave chat state refreshes without turn-record writes.
- Check the perspective comment in `envoy/context/diplomacy-context.ts` against MCP auto-completion and correct it if stale.
- Record `context.files` and the rendered `context.layout` per agent execution.

### 5. Add replay workspaces

Introduce the `Workspace` interface, replay workspace, and context resolver. Extend oracle retrieval, row types, replay routing, quota configuration, and context lifecycle. Preserve declared tools when restoring file support. Create and clean up a temporary workspace within each replay task.

### 6. Document and finish

Update these documents alongside implementation:

- `docs/developers/vox-agents/prompts.md`: shared knowledge, layouts, core prompts, and records directions.
- `docs/developers/vox-agents/overview.md`: records, reference initialization, catalog, load cleanup, and notes snapshots.
- `docs/developers/vox-agents/oracle.md`: file telemetry, temporary workspaces, T/T-1 cutoffs, and replay limitations.
- `docs/players/configuration.md`: records under File workspace, disk use, and notes surviving reloads.
- `vox-agents/AGENTS.md`: use layouts over the knowledge set and preserve records until load cleanup removes them.
- `docs/plans/strategist-orchestrator/02-working-folder.md`: Stage 2 should reuse the knowledge assembler and records.

Remove the temporary golden tests and snapshots after the refactor passes them and file mode is complete. Keep the behavior tests below.

## Verification

Use Vitest with existing mock contexts and temporary workspace directories. Cover behavior rather than exact prompt wording after removing the golden tests.

| Area | Required checks |
| --- | --- |
| Layouts | Placement, ordering, cache breakpoints, empty messages, and inline fallback for runs without bash |
| Events | A paced decision renders several turns while each record keeps its own refresh slice; narrowed retries change only the rendered window |
| Records | Markdown and JSON output, split files, complete concurrent writes, repeat writes preserving files, and correct catalog ranges and sizes |
| Failures | Record-write failure fails the strategist turn before its decision; reference call or write failure puts the session in error and starts no player loops |
| Reference | Four initialization calls per file-enabled seat/game, published only after success, reused by a later session |
| Loading | Loading N removes records from N onward; game notes and note snapshots remain |
| Mounts | Records reject writes and newly published files remain visible across bash commands |
| Hooks | Paced skips are recorded; chat refreshes do not record turns; files-disabled seats make no extra calls and create no record or archive folders |
| Notes | Changed completed decisions create snapshots; unchanged and skipped decisions do not |
| Telemetry | Explicit true/false file setting and correct layout, including a file-enabled greeting with an inline layout |
| Replay | Facts through T, notes and archived briefings through T-1, accurate catalog, no shared folders, source files unchanged, and temporary files preserved across commands |
| Replay isolation | Two concurrent variants of one source row cannot read each other's notes or scratch writes |
| Replay tools | Recorded file setting controls file support and quota; the recorded tool list still controls whether bash is available |

Update existing workspace mount, capability prompt, and bash-tool tests. Run the existing caching, step-budget, envoy, analyst, negotiator, pacing, and oracle suites, then `npm run build:all` and `npm run test:all` from the repository root.

Manually run several turns with a file-enabled simple strategist. Check the core prompt, bash reads, records, catalog, and changed-notes snapshots. Reload an earlier save and verify that excess records disappear while notes remain. Replay a recorded decision and confirm its workspace cutoffs. Finally, check a files-disabled seat for unchanged prompts and absence of records.

## Risks and limitations

- **Disk use:** full JSON, Markdown, and split Markdown accumulate throughout a game. Measure the implemented output before documenting a size estimate. There is no end-of-game cleanup; load-time pruning only removes the discarded turns. Temporary replay copies add disk use while tasks run.
- **Latency:** the simple strategist may spend more steps reading reports. It uses the existing files quota and compaction behavior.
- **First recorded view:** records keep the turn loop's refresh. Later events enter a later refresh, under their real event-turn keys.
- **Notes after reload:** live notes and note snapshots are retained, so they can carry knowledge from the discarded future. Snapshots capture completed strategist decisions, not every intervening chat write.
- **Replay fidelity:** facts are the recorded view of T; notes and archived briefings stop at T-1. Briefings already in the captured original prompt remain there. Rows from a discarded game continuation no longer have their original factual archive.

## Out of scope

- Configurable core-section lists or new agent variants.
- Moving briefing inputs, conversation history, or deal context out of their current prompts.
- Additional reference-detail queries beyond the four listings.
- Per-run publication histories or preservation of discarded game timelines.
- Restoring notes when a game is loaded, cross-game continuity, and records retention policies.
- Re-rendering recorded file-mode prompts inline for oracle experiments.
- The orchestrator's offline renderer; it should reuse this work later.
