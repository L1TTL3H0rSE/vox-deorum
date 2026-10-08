# Context records: a core prompt plus files

## Overview

Vox Deorum agents will build prompts from a shared set of game information. Each agent chooses a layout: which sections to show, in what order, and with which descriptions or filters.

Without file access, these layouts reproduce today's prompts. With file access, the host also writes game reports to a read-only records folder. The simple strategist keeps a smaller core prompt and reads detailed reports when needed. Other agents keep their current inline information and gain access to the records.

Records preserve the reports from each processed turn, including turns skipped by pacing. Agents can consult earlier turns after they leave the in-memory cache. A static reference, fetched once per game, supplies technology, policy, building, and unit listings.

Oracle replays use the recorded files setting. Each replay gets its own temporary workspace that emulates the original seat's folders, with factual records through turn T and notes, shared folders, and archived briefings through T-1. Its writes stay inside that replay.

The lifecycle is straightforward: reference setup must succeed before the session runs; record-write failures fail the strategist's turn. Processing a turn that already has records means the game was reloaded, so the host deletes that turn's records and every later one before recording it again. Agent notes survive a reload and may therefore retain knowledge from the discarded future.

Paths below are relative to `vox-agents/src/` unless they start with `vox-agents/`, `mcp-server/`, or `docs/`.

## Goal and success criteria

- Without `files`, refactored builders produce byte-identical `getSystem` and `getInitialMessages` output, make the same MCP calls, and create no records, reference, or archives.
- With `files`, each processed turn is recorded under `<telemetryDir>/workspaces/records/<gameID>-player-<playerID>/` and exposed as `/workspace/records`. The game's reference is exposed as `/workspace/reference`.
- File-mode layouts are used only by runs that declare `bash`. Restricted runs, such as a live envoy's greeting, keep their inline content.
- The simple strategist moves full players, cities, military, and events out of its prompt. It keeps identity, options, strategies, victory progress, a strategic players summary, and directions to the records.
- Reference initialization failures stop the entire session. Turn-record failures prevent that strategist decision from running with missing data.
- Every reload path (a new session loading a save, crash recovery, or a manual reload) removes the discarded records before the reloaded turn is recorded.
- Replay workspaces are independent, emulate the original seat's folders, use the agreed turn cutoffs, and leave source records, notes, and shared folders unchanged. Rows whose records were rewritten by a later reload, or are missing, fail instead of running.
- `npm run build:all` and `npm run test:all` pass.

## Current state

| Area | Existing behavior and source |
| --- | --- |
| State collection | `refreshGameState` in `strategist/strategy-parameters.ts` fetches players, events, cities, options, victory progress, and military reports. It updates the seat's cached state in place. |
| Turn processing | `strategist/vox-player.ts` calls `ensureGameState` for every processed turn, then applies pacing and optionally runs the strategist. Chat can refresh uncached state independently. |
| Event windows | `state.events` holds a refresh's event slice. `withEventWindowFallback` builds `state.mergedEvents` for a decision covering several turns and narrows it on context overflow. |
| Briefings | `requestBriefing` in `briefer/briefing-utils.ts` deduplicates generation. Outputs enter `state.reports`; staffed strategists subsequently assemble their own combined briefing there. |
| Prompts | Strategists, briefers, and `buildGameContextMessages` assemble Markdown by hand, using `jsonToMarkdown` and each report's `_markdownConfig`. |
| Workspaces | `utils/workspace/player-workspace.ts` mounts game notes, optional shared folders, and scratch space. Bash output is capped at 8,000 characters per stream. The bash tool's description in `utils/tools/bash-tool.ts` lists the seat's mounts, so it depends on the files setting. |
| Agent preparation | `infra/vox-execute.ts` prepares system text, initial messages, and run tools in that order. `getRunTools` is a pure function of its inputs and adds bash to eligible runs. File-enabled contexts use the seat's `files.quota` (default `defaultFilesQuota` in `strategist/seat-config.ts`) as the step budget. |
| Session startup | `StrategistSession.handleGameSwitched` creates players, registers tools, and starts their loops. It runs only when the gameID changes, and the gameID persists across save and load. A reload of the same game, including crash recovery through `recoverGame`, keeps the existing players. Fatal setup failures must use the session's error path because throwing from a notification handler alone does not stop the session. |
| Oracle | `oracle/retriever.ts` extracts the first step's prompt and tools from telemetry. `oracle/replayer.ts` runs rows, models, and repetitions concurrently, each inside its own root run, using schema-only tools, so a recorded bash call currently performs no file operation. |

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

The strategic players summary's fields will be designed after the first revision of this work lands. Until then, the simple strategist's file-mode layout keeps the full players section inline.

`infra/vox-execute.ts` resolves the run's tools with `getRunTools` first, then prepares the system text and initial messages, and stores the resolved list on the execution frame. `contextLayoutMode(context)` reads that list and selects file mode when files are enabled and the run's tools include bash. An undefined tool list means all registered tools. Otherwise it selects inline mode.

The records part names `/workspace/records` and `/workspace/reference`, the recorded turn range, the current turn folder, and the record folders covering events since the last completed decision. That event range stays the same even if an inline retry uses a narrower window. It lists moved sections and their file patterns, points to `CATALOG.md`, and tells agents to trust the catalog over a directory listing. Its contents stay fixed during the turn; changing file sizes and newly generated briefings belong in the catalog. This preserves the live envoy's cache boundaries.

Diplomacy background, deals, conversation rows, and historical episode presentation remain in their existing agent contexts. Telepathist and archivist contexts remain without files.

### Records and catalog

Add `SeatRecords` in `knowledge/records.ts`, cached by seat and game on `VoxContext`. Use the existing workspace path validation.

The seat's records folder contains:

| Path | Contents |
| --- | --- |
| `CATALOG.md` | Generated section index, turn ranges, file sizes, and query guidance |
| `.records.json` | The current records generation and the generation each turn folder was written in |
| `game/<key>.md` and `.json` | Situation and civilization, written on the first recorded turn |
| `turns/<N>/<key>.md` and `.json` | Complete turn reports |
| `turns/<N>/<key>/<part>.md` | Markdown split by civilization, city owner, military zone, or event category |
| `turns/<N>/briefings/<kind>.md` | Generated briefing text |

Markdown uses `jsonToMarkdown` with the source report's rendering configuration and full data. JSON omits `_markdownConfig`. Agent-specific views affect inline rendering only. Split filenames use readable slugs with collision suffixes.

Reports can exceed the bash output cap even after splitting. The catalog explains how to select smaller pieces with `grep`, `head`, `sed -n`, or `jq`. It lists compressed turn ranges, such as `1-40, 42`, and the latest files' sizes.

`recordTurn(knowledge)` writes the factual sections. The knowledge set's briefings section is for inline rendering; `recordBriefing(turn, kind, text)` is the sole writer of archived briefings. It writes the briefer's own output when generation resolves, before a strategist's assembled report can replace it. Repeated briefing writes keep existing files.

Serialize host writes through a per-seat promise chain and publish files with a temporary file plus rename. Each write publishes its data files first and regenerates `CATALOG.md` last, so the catalog lists only complete turns and briefings. Concurrent readers, such as a diplomat chat during a strategist turn, can see a partly written turn folder, but never a catalog entry for one. Errors propagate to the caller. A record-write failure fails that processed turn, whether pacing would have selected a decision or a skip. The existing turn-error path handles the failure, and the loop can process the next turn. Briefing-write failures propagate through the requesting run as well.

Mount `/workspace/records` and `/workspace/reference` read-only whenever files are enabled, including seats without a game-notes mount. Files written after the first bash command must be visible to later commands. Add both folders to the workspace capability instructions and bash mount description.

### Reloads

A reload is detected by the records themselves. When `recordTurn` receives turn N and turn N already has records, the game was reloaded: delete the records for N and later turns, including their briefings, increment the records generation, and then record N. This covers a new session loading a save, crash recovery through `recoverGame`, and a manual reload, without a separate hook on each path. Normal play processes each turn once, so it never triggers this.

Both `game/` and the reference remain: situation and civilization come from static game settings, and the reference contains static listings. Live agent notes, shared folders, and workspace snapshots also remain. There is no superseded timeline folder or notes restoration. Between a reload and the first processed turn, chats can still see the discarded records.

The generation lets replay detect rewritten history. `.records.json` stores the current generation and the generation each turn folder was written in, and every file-enabled agent span records the generation that was current when it ran.

### Game reference

`StrategistSession.handleGameSwitched` initializes the reference once per game, after registering the seats' tools and before starting any player loops or autoplay, when at least one seat has files enabled. Prepare every seat first, then start the players. The reference lives at `<telemetryDir>/workspaces/references/<gameID>/` and every file-enabled seat mounts it read-only.

The four listing tools take no `PlayerID`, so one set of calls serves every seat:

| Tool | Arguments | Listing contents |
| --- | --- | --- |
| `get-technology` | `MaxResults: 5000`, no search | Names, help, cost, era, and technologies unlocked |
| `get-policy` | `MaxResults: 5000`, no search | Names, help, branch, level, and era |
| `get-building` | `MaxResults: 5000`, no search | Names, help, cost, prerequisite technology, era, and civilization uniqueness |
| `get-unit` | `MaxResults: 5000`, no search | Names, descriptions, combat values, cost, prerequisite technology, era, and civilization uniqueness |

These are listing results, not complete detailed dependency reports. A query that resolves to exactly one item returns a detailed report instead, so the writer must not assume every result is a listing row. Without files there are no added calls; recording turns and briefings adds no MCP calls.

Create the complete reference in a temporary directory and publish it after all four calls and their file writes succeed. An existing published reference is reused on a later session. Failed setup is discarded, and any fetch, error result, or write failure stops the entire session through its fatal setup path. Handle both MCP errors and the database tools' returned `Error` field. There is no per-turn reference retry mechanism.

### Workspace snapshots

After a completed strategist decision on turn N, snapshot the seat's game-notes folder and every shared folder it mounts to `<workspaceRoot()>/archives/<gameID>-player-<playerID>/turn-<N>/`, as `game/` and `shared/<name>/`, if their combined contents changed. Hash sorted relative paths and contents to compare with the latest snapshot at or before N. Recompute that comparison from disk after restart.

The label means folders captured after decision N, so replay T selects the latest snapshot at or before T-1. Skipped turns do not snapshot. A repeated decision at N can replace its snapshot with the newly captured contents; snapshots are separate from write-once factual records. A seat with neither a game-notes mount nor shared folders has nothing to snapshot.

Reloading does not rewind notes or shared folders, or purge their snapshots. Retained notes can contain knowledge from a discarded future, including in snapshots taken after play resumes. This is a documented limitation, not a separate timeline-management feature.

### Telemetry and oracle replay

Record three facts on every agent span:

| Attribute | Meaning |
| --- | --- |
| `context.files` | The context's resolved files setting (game access, shared folders and their access, quota), or `false` |
| `context.layout` | `inline` or `files`: how this run's initial messages were rendered |
| `context.records_generation` | The records generation current when the run started, when files are enabled |

For example, a file-enabled envoy greeting records its files setting and `context.layout = inline`, because that run cannot use bash. The retriever carries these fields and the source telemetry root into `RetrievedRow`. Missing fields on older rows default to `false` and inline. Replay enables file support from `context.files`, not by inspecting prompt text or inferring it from the layout.

Add a shared `Workspace` interface with `exec(command, signal)`. `PlayerWorkspace` implements it. A root run can carry its own workspace; the bash tool uses the active root run's workspace when one is set and the seat's normal workspace otherwise.

`ReplayWorkspace` owns a unique temporary directory for each replay execution, including each model variant and repetition, and is passed to that task's `withRun`. It reproduces the original seat's mounts so the model sees the same folders. Populate it before the first step:

| Virtual path | Replay contents |
| --- | --- |
| `/workspace/records` | Read-only copies of game data and factual turn records through T; archived briefings only through T-1; a catalog generated from those copied files |
| `/workspace/reference` | The game's published reference, mounted read-only |
| `/workspace/game` | Copy of the snapshot's `game/` folder, with the original access, or empty if no snapshot exists |
| `/workspace/shared/<name>` | Copy of the snapshot's `shared/<name>/` folder, with the original access, or empty if no snapshot exists |
| `/tmp` | Writable scratch space for this execution |

The snapshot is the latest one at or before T-1. Copying the selected files keeps filtering simple: turn T's briefing folder is omitted while its factual reports are included. Do not mount the live archive or live shared folders. Files written in one bash call persist for the next call in that replay. Dispose of the temporary directory when the execution ends.

Before copying, check the row against `.records.json`. If the source records folder is missing, or any copied turn folder was written in a later generation than the row's `context.records_generation`, the row fails with an error and does not run. This catches rows from a game continuation that a reload later discarded.

Use the existing oracle context for rows with files disabled and one file-enabled context for each distinct recorded files setting, so each bash tool description matches the original. Each file-enabled context uses the recorded quota, schema-only tools, and a real bash tool registered after schema replacement. Keep the original run's declared tool list, so restricted runs do not gain bash just because the replay context has it. Give the contexts distinct identities, register their telemetry outputs under the oracle experiment, close them all during shutdown, and expose their output locations in the replay result logging.

Replays will more often send the complete recorded conversation, including the original bash calls and their results, so the model makes only the final decision. This plan keeps the oracle's current first-step replay. The emulated workspace still matters for full-history replay, because a model can issue new bash calls after the recorded history ends. Full-history replay needs its own design, especially around which step to cut at and how recorded tool results relate to the emulated folders.

## Implementation steps

### 1. Capture existing prompts

Create a compact recorded game-state fixture under `vox-agents/tests/fixtures/game-state/`, using local telemetry and cached tool definitions. Include metadata with `YouAre`, all six reports, and their Markdown configurations. Keep any capture script local.

Add temporary golden tests under `vox-agents/tests/mock/prompts/` for the four LLM strategists, the simple briefer, all three specialized briefer modes, and `buildGameContextMessages`. Pre-fill briefings, include a past briefing, fix working-memory instructions, and mock episode retrieval. Capture `getSystem` and `getInitialMessages` before refactoring.

### 2. Introduce sections and layouts

Add the knowledge registry, assembler, and renderer. Port each builder while keeping the golden tests unchanged. Preserve the separate turn and decision event inputs, and render each overflow retry from the current selected window.

Keep `buildGameContextMessages` inline by default. Move `getRunTools` ahead of prompt preparation in `vox-execute.ts` and store the result on the execution frame for `contextLayoutMode`. Add the records part to adopting layouts and mark the simple strategist's moved reports as inline-only.

### 3. Add records, reference, and snapshots

Implement `SeatRecords`, catalog generation, record splitting, generations and reload pruning, and changed-folder snapshots. Add the cached records accessor and the read-only records and reference mounts. Update workspace capability instructions and bash descriptions.

In `StrategistSession.handleGameSwitched`, register and prepare all players before launching their execution loops, and initialize the game reference there. Route setup failures through the existing fatal session path, including abort and completion signaling; do not rely on an exception escaping a notification callback.

### 4. Connect turn and briefing hooks

- After `ensureGameState` in `vox-player.ts`, record each processed turn when files are enabled, before pacing can skip or the strategist can run.
- After a completed decision, snapshot changed folders using that decision's turn number.
- In `requestBriefing`, await recording of a newly generated output. Propagate write failures instead of treating them as an unavailable briefing.
- Leave chat state refreshes without turn-record writes.
- Check the perspective comment in `envoy/context/diplomacy-context.ts` against MCP auto-completion and correct it if stale.
- Record `context.files`, the rendered `context.layout`, and `context.records_generation` per agent execution.

### 5. Add replay workspaces

Introduce the `Workspace` interface, the root-run workspace, and the replay workspace. Extend oracle retrieval, row types, generation checks, replay routing, per-setting contexts, and context lifecycle. Preserve declared tools when restoring file support. Create and clean up a temporary workspace within each replay task.

### 6. Document and finish

Update these documents alongside implementation:

- `docs/developers/vox-agents/prompts.md`: shared knowledge, layouts, core prompts, and records directions.
- `docs/developers/vox-agents/overview.md`: records, the game reference, catalog, reload pruning, generations, and workspace snapshots.
- `docs/developers/vox-agents/oracle.md`: file telemetry, emulated temporary workspaces, T/T-1 cutoffs, generation checks, and replay limitations.
- `docs/players/configuration.md`: records and reference under File workspace, disk use, and notes surviving reloads.
- `vox-agents/AGENTS.md`: use layouts over the knowledge set and preserve records until reload pruning removes them.
- `docs/plans/strategist-orchestrator/02-working-folder.md`: Stage 2 should reuse the knowledge assembler and records.

Remove the temporary golden tests and snapshots after the refactor passes them and file mode is complete. Keep the behavior tests below.

## Verification

Use Vitest with existing mock contexts and temporary workspace directories. Cover behavior rather than exact prompt wording after removing the golden tests.

| Area | Required checks |
| --- | --- |
| Layouts | Placement, ordering, cache breakpoints, empty messages, and inline fallback for runs without bash, using the tools resolved before prompt preparation |
| Events | A paced decision renders several turns while each record keeps its own refresh slice; narrowed retries change only the rendered window |
| Records | Markdown and JSON output, split files, complete concurrent writes, catalog written after data files, repeat briefing writes preserving files, and correct catalog ranges and sizes |
| Failures | Record-write failure fails the strategist turn before its decision; reference call or write failure puts the session in error and starts no player loops |
| Reference | Four initialization calls per file-enabled game regardless of seat count, published only after success, reused by a later session, and mounted for every file-enabled seat |
| Reloads | Recording an already-recorded turn N, as after crash recovery with the same players, removes N onward, increments the generation, and keeps `game/`, the reference, notes, shared folders, and snapshots |
| Mounts | Records and reference reject writes and newly published files remain visible across bash commands |
| Hooks | Paced skips are recorded; chat refreshes do not record turns; files-disabled seats make no extra calls and create no record, reference, or archive folders |
| Snapshots | Changed completed decisions create snapshots covering game notes and shared folders; unchanged and skipped decisions do not |
| Telemetry | Recorded files setting or `false`, correct layout including a file-enabled greeting with an inline layout, and the records generation |
| Replay | Facts through T, notes, shared folders, and archived briefings through T-1, accurate catalog, original mounts and access, matching bash description, source files unchanged, and temporary files preserved across commands |
| Replay checks | Rows with a missing records folder or a later-generation turn fail without running |
| Replay isolation | Two concurrent variants of one source row cannot read each other's notes, shared folder, or scratch writes |
| Replay tools | Recorded files setting controls file support, quota, and bash description; the recorded tool list still controls whether bash is available |

Update existing workspace mount, capability prompt, and bash-tool tests. Run the existing caching, step-budget, envoy, analyst, negotiator, pacing, and oracle suites, then `npm run build:all` and `npm run test:all` from the repository root.

Manually run several turns with a file-enabled simple strategist. Check the core prompt, bash reads, records, reference, catalog, and changed-folder snapshots. Kill the game process mid-run and let crash recovery reload an earlier autosave; verify that the discarded records disappear once the reloaded turn is processed while notes remain. Replay a recorded decision and confirm its workspace cutoffs and mounts. Finally, check a files-disabled seat for unchanged prompts and absence of records.

## Risks and limitations

- **Disk use:** full JSON, Markdown, and split Markdown accumulate throughout a game, and snapshots now include shared folders. Measure the implemented output before documenting a size estimate. There is no end-of-game cleanup; reload pruning only removes the discarded turns. Temporary replay copies add disk use while tasks run.
- **Latency:** the simple strategist may spend more steps reading reports. It uses the existing files quota and compaction behavior.
- **First recorded view:** records keep the turn loop's refresh. Later events enter a later refresh, under their real event-turn keys.
- **Reload window:** pruning happens when the reloaded turn is first processed, so chats in between can still read the discarded records.
- **Notes after reload:** live notes, shared folders, and snapshots are retained, so they can carry knowledge from the discarded future. Snapshots capture completed strategist decisions, not every intervening chat write.
- **Replay fidelity:** facts are the recorded view of T; notes, shared folders, and archived briefings stop at T-1. Briefings already in the captured original prompt remain there. Rows from a discarded game continuation fail their generation check instead of replaying.

## Out of scope

- Configurable core-section lists or new agent variants.
- Moving briefing inputs, conversation history, or deal context out of their current prompts.
- Additional reference-detail queries beyond the four listings.
- Per-run publication histories or preservation of discarded game timelines.
- Restoring notes when a game is loaded, cross-game continuity, and records retention policies.
- Re-rendering recorded file-mode prompts inline for oracle experiments.
- Full-history oracle replay that continues from a later recorded step.
- The orchestrator's offline renderer; it should reuse this work later.
