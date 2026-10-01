# just-bash workspace for all agents

This plan gives every agent optional file access through a simulated bash, and removes the Codex and Claude Code filesystem tools. Paths are relative to `vox-agents/src/` unless they start with `vox-agents/` or `docs/`. Status: draft for review, not implemented.

## Context

Today only Codex and Claude Code agents can touch files. The model option `hostTools: ["Read"|"Write"|"Web"]` maps to each CLI's own file tools (Claude Code Read/Glob/Grep/Write/Edit, Codex sandbox levels), with one temp folder per provider per player. Every other provider gets nothing, and notes do not follow a switch between Codex and Claude Code.

We will give every tool-using agent of a seat, on any provider, a `bash` tool backed by [just-bash](https://github.com/vercel-labs/just-bash): a simulated bash with a virtual filesystem whose mounts map to real folders. Codex and Claude Code lose their filesystem tools and working folders; their native `Web` stays.

## Goal and success criteria

- A seat setting `files` turns file access on for every tool-using agent of that seat, whatever the provider.
- All agents of one player in one game share one folder: `<telemetryDir>/workspaces/games/<gameID>-player-<playerID>/`.
- Optional named shared folders persist across games: `<telemetryDir>/workspaces/shared/<name>/`.
- Agents get a `bash` tool, a system prompt on how to use the workspace, and a continuation nudge that allows workspace work while still steering toward completion.
- Without `files`, step limits, stop checks, malformed-call retries, and overflow handling behave exactly as today.
- With `files`:
  - A step that only calls `bash` while the workspace is open does not count toward the agent's step limit. Bash use is bounded by a soft, configurable quota per run, and the continuation nudge tells the agent how much quota is left. After closure, bash stays listed but returns a failure without running commands, and further bash steps count toward the step limit.
  - A long run compacts itself: old bash output is dropped once the request nears a size threshold, or once after a context-length error.
  - Anthropic-family models cache the run's initial prompt (instructions plus game state), so later steps of the same run read it from cache. Claude Code caching is left as an open question (Step 7).
- `hostTools` accepts only whitelist entries (`Web`). Unsupported entries throw the normal validation error; there is no migration handling.
- Codex always runs with `sandbox: 'disabled'` and no `cwd`. Claude Code exposes only WebFetch/WebSearch (when Web is on) and gets no working directory.
- `npm run build:all` and `npm run test:all` pass.

## Config design

One setting, `files`, resolved like `triage`: seat (`llmPlayers.<n>.files`), else session config, else root `config.json`, else off. The highest level that sets it replaces lower levels whole (no merging).

```jsonc
"files": "write"                    // shorthand for { "game": "write" }
"files": {
  "game": "write",                  // false | "read" | "write" (default false)
  "shared": { "lessons": "write", "reference": "read" },  // name -> "read" | "write"
  "quota": 20                       // bash calls per agent run (default 20)
}
```

The size threshold for compaction is a model option, `options.continuityThreshold` (default 100,000 tokens), the same name the sibling plan `docs/plans/context-continuity.md` defines, so both plans share one knob.

Virtual layout seen by the agent (cwd `/workspace`):

| Virtual path | Real folder | Lifetime |
| --- | --- | --- |
| `/workspace/game/` | `<telemetryDir>/workspaces/games/<gameID>-player-<playerID>/` | One game, one player |
| `/workspace/shared/<name>/` | `<telemetryDir>/workspaces/shared/<name>/` | Across games and seats |

- `"read"` mounts just-bash `OverlayFs({ root, readOnly: true })`; `"write"` mounts `ReadWriteFs({ root })`. The base is an `InMemoryFs`, so `/tmp` scratch never touches disk.
- Shared names must match `^[a-z0-9][a-z0-9_-]*$`. Validation errors name the config path, like `resolveSeatTriage`.
- Caveat to document: two seats of the same game writing one shared name can pass information to each other. Users avoid that with different names per seat or read-only access.

## Current state

- Policy: `host-tools.ts` (`vox-agents/src/utils/models/providers/`) validates `hostTools`, creates per-provider working dirs, seeds `AGENTS.md`/`CLAUDE.md` (`seedHostWorkspaceGuide`, `getHostWorkspaceGuide`), and defines `isHostCapabilityProvider` from `hostWorkspaceGuideFiles`.
- Claude Code: `claude-code.ts` `claudeCodeMetaToolExpansion`, `expandClaudeCodeTools`, `buildClaudeCodeModel` (sets `cwd`, `tools`, `allowedTools`, `permissionMode`).
- Codex: `codex.ts` `buildCodexProviderOptions(model, runtimeIdentity?, previousResponseId?)` maps access to `sandbox` and `cwd`. The web-only path already runs with `sandbox: 'disabled'` and no `cwd`.
- Prompt: `host-capability-prompt.ts` `hostCapabilityInstruction` / `hostCapabilityMiddleware`, installed outermost in `getModel` (`utils/models/models.ts`) for CLI providers only. It uses `clientFunctionToolNames` from `required-tool-choice.ts`.
- `models.ts`: `getModel(config, { workingDirId, ... })`, `buildProviderOptions(model, runtimeIdentity?, previousResponseId?)`, and a re-export of `ModelRuntimeIdentity`.
- Step loop: `executeAgentStep` in `infra/vox-execute.ts` builds `runtimeIdentity`, resolves `stepActiveTools`, derives `toolChoice` from it, appends `agent.continuationNudge(...)` after step 1, records `hostCapabilityTelemetryAttributes`, and emits provider-executed tool spans for CLI providers.
- Tools: `VoxContext.registerTools` / `registerAgentTools` (`infra/vox-context.ts`) fill one flat `context.tools`. One `VoxContext` per seat, created in `strategist/vox-player.ts`, which sets `context.triage = resolveSeatTriage(...)` before `strategist-session.ts` calls `registerTools()`. `strategist-session.ts` also preflights each seat's triage at session start. `createSimpleTool` (`utils/tools/simple-tools.ts`) is the wrapper to reuse (tracing, key normalization, `context.currentParameters`). Tool input keys are capitalized (`send-message` takes `Message`).
- Root config: `utils/config/diff.ts` keeps only the keys in `topLevelKeys` (includes `triage`) when loading and saving `config.json`. `utils/config.ts` then explicitly copies supported fields into the runtime config.
- Step loop: `executeAgent` (`infra/vox-execute.ts`) runs one `streamText` call per step and keeps the growing `messages` history; each step's model is rebuilt by `getModel`.
- Step limits all compare `allSteps.length` with `maxSteps`:
  - `VoxAgent.maxSteps = 3`; base `stopCheck` and `retriesMalformedTerminal` (`infra/vox-agent.ts`).
  - `SimpleStrategistBase.maxSteps = 5`, `LiveEnvoy.maxSteps = 10` (own `stopCheck`), `Negotiator.maxSteps = 4` (own `stopCheck`), `OracleAgent.maxSteps = 5`.
  - `Briefer.stopCheck` (`briefer/briefer.ts`) stops when any step so far has 10+ chars of text, or at a hard-coded 3 steps. A step with "checking notes" text plus a bash call would end the briefing.
  - `Telepathist` has its own 50-step cap; its contexts never enable files.
- Prompt caching today assumes one-step runs whose game state is not reused:
  - Anthropic-family models (direct, Vertex Claude, OpenRouter): one `cacheControl` breakpoint on the small game-context system message (`simple-strategist*.ts`, `simple-briefer.ts`, `specialized-briefer.ts`, `buildGameContextMessages` in `strategy-parameters.ts`). The large game-state user message after it is never cached. Live envoys set three static breakpoints (`envoy/envoy.ts` strategy note, `markBreakpointOnLast`, `MAX_CACHE_BREAKPOINTS = 4`); `cacheBreakpoint` already lives in `utils/models/cache-breakpoint.ts`.
  - Claude Code: `ai-sdk-provider-claude-code` (`convertToClaudeCodeMessages`) flattens every message into one user text block (system text first, then `Human:` / `Assistant:` rows), and each step is a fresh CLI query. The CLI caches automatically, but step 2's block is a longer copy of step 1's, so nothing past the CLI's own system prompt is reused between steps.
- Nudge: `VoxAgent.continuationNudge` uses `buildCompletionToolsNudge` (`utils/tools/tool-names.ts`).
- Other readers of host policy: `utils/models/concurrency.ts` (batch-mode guard via `isHostCapabilityProvider`), `utils/telemetry/host-capabilities.ts` (`host.capability` span attribute).
- The web telemetry route (`web/routes/telemetry.ts`, `/databases`) recursively lists every `.db` under `telemetry/`, so a `sqlite3` file an agent writes in a workspace would show up as a game database.
- The only local config using `hostTools` is `vox-agents/configs/gpt-5.6-luna-tools-standard-fixed-per-5.json` (gitignored, not a repo deliverable).

## Approach

Use `just-bash` directly (one dependency), wrapped with `createSimpleTool`. We skip the `bash-tool` package: it adds `readFile`/`writeFile` tools we do not need and a second peer dependency on `ai`, and our wrapper already handles tracing, key normalization, and per-context parameters.

The `bash` tool is registered in a context only when that context's `files` setting is on, so `context.tools` decides availability. The step loop adds `bash` to each tool-using agent's active list, which avoids touching every `getActiveTools` override. Quota exhaustion keeps bash in the request and closes command execution through the tool's per-step allowance. VD keeps the full tool registry on the context, but the AI SDK filters the request and executable tool set through `activeTools`; changing that list can remove tools from a request.

## Steps

### 0. Spike (gate for everything else)

Add `just-bash` to `vox-agents` from the repo root (`npm install just-bash -w vox-agents`). In a throwaway script in the scratchpad, confirm on Windows:

1. `ReadWriteFs` and `OverlayFs` accept a Windows `root` and work under `MountableFs` mount points.
2. Paths cannot leave a mount: `cat ../../../x`, absolute host paths, and `ln -s` to an outside target all fail or stay virtual. If any of these reach the real disk outside the root, stop and revisit the design with the user. We do not try to filter scripts ourselves.
3. Two concurrent `exec` calls on one `Bash` instance do not interfere. If they do, create a fresh `Bash` per call over the shared `MountableFs`.
4. An `AbortSignal` passed to `exec` stops a long script.

Adjust Step 2 to the findings.

### 1. Config types and resolution

- `types/config.ts`:
  - `export type FileAccess = 'read' | 'write';`
  - `export interface FilesConfig { game?: FileAccess | false; shared?: Record<string, FileAccess>; quota?: number; }`
  - `export type FilesSetting = false | FileAccess | FilesConfig;`
  - Add `files?: FilesSetting` next to `triage` on `VoxAgentsConfig`, the session config, and `PlayerConfig`.
- `utils/config/diff.ts`: add `'files'` to `topLevelKeys`.
- `utils/config.ts`: copy `files: fileConfig.files` into the object returned by `loadConfig`, next to `triage`.
- `strategist/seat-config.ts`: `resolveSeatFiles(playerConfig, sessionFiles?, slot?): FilesConfig | undefined`. Same precedence as `resolveSeatTriage`; expands the shorthand; validates values and shared names; returns `undefined` when nothing is mounted.
- `strategist/vox-player.ts`: accept `files` in `VoxPlayerOptions`; set `this.context.files = resolveSeatFiles(...)` next to triage.
- `strategist/strategist-session.ts`: pass `files: this.config.files` where it passes `triage`, and call `resolveSeatFiles` in the per-seat preflight so bad config fails at session start.
- `infra/vox-context.ts`: `public files?: FilesConfig;` with a comment like the `triage` one.

### 2. Workspace and bash tool

- New `utils/workspace/player-workspace.ts`:
  - `workspaceRoot()` returns `<config.telemetryDir || 'telemetry'>/workspaces`, resolved from cwd.
  - `class PlayerWorkspace(files, gameID, playerID)`. On first `exec` it creates the real folders, seeds guides, builds a `MountableFs` (base `InMemoryFs`, mounts per Config design), and one `Bash` with `cwd: '/workspace'`, network and Python/JS off, default limits.
  - `exec(command, signal)` returns `{ stdout, stderr, exitCode }`, each stream capped (8,000 chars, with a `[truncated N chars]` marker).
  - Guide seeding: move the create-once logic from `seedHostWorkspaceGuide` (`flag: 'wx'`, ignore `EEXIST`, log other errors) here. Seed `AGENTS.md` at each writable mount root. The game guide keeps today's content (notes vs snapshots; observations vs inferences vs plans; current tools override stale notes; no untrusted text in the guide) minus the CLI shell-policy section. The shared guide says the folder outlives the game and is seen by other seats and games, so it holds generalized lessons and reusable references, never current-game state.
- `VoxContext`: cache `PlayerWorkspace` instances by `gameID-playerID` so all agents of a seat share one.
- New `utils/tools/bash-tool.ts`: `createBashTool(context)` via `createSimpleTool`. Name `bash`, input `{ Command: string }`, description listing the mounts with their access and the main commands (ls, cat, grep, rg, sed, awk, find, jq, sqlite3, tee, heredocs). Execute first checks the current execution frame's step allowance (Step 5). When closed, return `{ stdout: '', stderr: 'Workspace quota exhausted for this run.', exitCode: 1 }` without resolving the workspace or running a command. Otherwise resolve the workspace from `parameters.gameID`/`playerID` and pass `context.currentSignal()`.
- `VoxContext.registerAgentTools`: when `this.files` is set, register `this.tools.bash = createBashTool(this)`.

Steps 3 to 5 change shared signatures and must land together; the build is expected to pass only after all three.

### 3. Strip CLI filesystem support

- `types/config.ts`: `hostMetaTools = ['Web']`; remove `everythingHostTools`; rewrite the `hostTools` doc comment.
- `host-tools.ts`: keep whitelist validation (`resolveHostToolCapabilities` returns `{ web }`; every entry outside `hostMetaTools` throws the normal unsupported-entry error listing `Web`) and `isHostCapabilityProvider`, now backed by a plain set of `codex` and `claude-code`. No legacy aliases, migration message, or extra startup preflight. Delete `ModelRuntimeIdentity`, `HostToolAccess*`, `resolveWorkingDirectory` and its path helpers, `hostWorkspaceGuideFiles`, guide seeding, and `resolveHostToolAccess`.
- `claude-code.ts`: expansion is only `Web: ['WebFetch', 'WebSearch']` (plus `TodoWrite` when on, as now). No `cwd`; keep `tools`, `permissionMode: 'dontAsk'`, `allowedTools`. Drop the `runtimeIdentity` parameter.
- `codex.ts`: `CodexRequestExtension.sandbox` becomes `'disabled'`, no `cwd`; signature `buildCodexProviderOptions(model, previousResponseId?)`. Update comments in `codex.ts`, `required-tool-choice.ts`, and `codex-response.ts` that describe host file tools.
- `models.ts`: `buildProviderOptions(model, previousResponseId?)`; `getModel` option `workingDirId` becomes `files?: FilesConfig`; remove the `ModelRuntimeIdentity` re-export.
- `vox-execute.ts`: remove `runtimeIdentity`; pass `files: host.files` to `getModel`.

### 4. Workspace system prompt

- Replace `host-capability-prompt.ts` with a provider-neutral `utils/models/capability-prompt.ts`: `capabilityInstruction({ files, web }, terminalNames)` and `capabilityMiddleware(...)`, keeping the `# Extra Capabilities` heading.
  - File guidance appears only when `bash` is among `clientFunctionToolNames(params)`, so it never describes a tool the call lacks.
  - Content: you share `/workspace/game` with the other agents of your civilization; read its `AGENTS.md` first; each shared folder, its access, and that it outlives the game; keep notes organized; batch reads and writes into one script per call because every call is a full model round trip; write files with heredocs; current game tools beat stale notes; then the existing sentence about using capabilities before the terminal tools.
  - The Web sentence stays, only for Codex/Claude Code with `hostTools: ['Web']`.
- `getModel`: install the middleware outermost for any provider when `files` is set, or for a CLI provider when Web is on.

### 5. Step counting, bash quota, nudge

Two rules apply when `files` is enabled. Without files, every step counts as today, including an invalid call that names an unavailable `bash` tool:

1. A free workspace step contains at least one tool call, every call is `bash` (valid or invalid), and the run had quota remaining at the start of that step. Empty, text-only, mixed, and post-closure steps count toward `maxSteps`.
2. Bash is bounded softly by `files.quota` attempts per agent execution (default 20). Count every emitted bash call, including malformed calls and calls in mixed steps. All commands in a step that starts with quota remaining may finish, even if parallel calls overshoot. Later steps keep bash listed, but it returns a failure without executing commands.

- `utils/tools/bash-tool.ts` also exports `bashToolName = 'bash'`, `isWorkspaceStep(step)` (at least one call and all names are bash), and `bashCallsUsed(allSteps)` (counts `toolCalls`, including invalid calls).
- `seat-config.ts`: `resolveSeatFiles` validates `quota` as a positive integer and fills the default, so `context.files.quota` is always set.
- `infra/vox-agent.ts`: `protected countedSteps(allSteps, files?)` scans steps in order, tracking bash attempts before each step. Exempt a workspace step only when files are enabled and that prior count is below the quota. Base `stopCheck` and `retriesMalformedTerminal` compare this count with `maxSteps`; pass `context.files` through the retry helper.
- `LiveEnvoy.stopCheck` and `Negotiator.stopCheck`: the same swap, using `context.files`.
- `Briefer.stopCheck`: accept the context argument, replace the hard-coded 3 with the same counted limit (the base default is already 3), and skip only free workspace steps when scanning for briefing text, so "checking notes" plus an admitted bash call does not end the briefing. Share the eligibility calculation with step counting.
- `executeAgentStep`, after `stepActiveTools` and `stepToolChoice` are resolved (so tool-less agents keep `auto` and never get bash): when `host.tools.bash` exists, append `'bash'` to a copied non-empty active list regardless of remaining quota. `undefined` already means all registered tools and includes bash; an explicit empty list stays empty. Avoid duplicate names.
- Compute `left = Math.max(0, files.quota - bashCallsUsed(allSteps))` before the model call. Bind whether this step may execute bash (`left > 0` and bash is active) to the active `ExecutionFrame` in `infra/vox-run.ts`, with accessors on `VoxContext` for the loop and tool. Each nested or concurrent agent execution owns its allowance; do not put it on the shared workspace or a seat-wide mutable counter. Hold this allowance fixed through the step so parallel calls may finish after overshooting.
- Reminders:
  - The capability prompt (Step 4) states the run's quota.
  - The loop composes the agent's continuation nudge with one sentence naming `left` and saying to finish with the completion tools. When bash is active and `left` is 0, it says the workspace is closed for this run and further calls return a failure. The builder sits next to `buildCompletionToolsNudge` in `tool-names.ts`.

### 6. Auto compaction within a run

Pulled from the sibling plan `docs/plans/context-continuity.md` (threshold, 75 percent reminder, one overflow retry, older-reasoning removal), scoped to a single run because that plan's carried history does not exist yet. Only runs with `files` compact; others keep today's overflow behavior. Workspace notes are what make dropping old output safe.

- `utils/models/models.ts` (or a small `utils/models/thresholds.ts`): `continuityThreshold(model)` reads `options.continuityThreshold`, default 100,000, warns and falls back on a non-positive or non-finite value. Add the option to `LLMConfig` with a doc comment.
- `utils/models/token-counter.ts`: add `countRequestTokens(messages)` for compaction decisions. Include text, tool names and inputs, serialized tool-result outputs (including errors), retained reasoning, and message overhead. Keep the existing reasoning-only and visible-output counters used by telemetry unchanged. This remains a local estimate, not an exact provider token count.
- New `utils/prompts/message-history.ts` (the module the sibling plan names), pure functions on copies:
  - `compactWorkspaceTraffic(messages, keepFrom)`: replaces the output of every `bash` tool result before index `keepFrom` with a short stub saying the output was dropped and to re-run the command or read notes. Calls stay, so call/result pairs remain valid. Messages before the cache anchor and all non-bash traffic are untouched, so the cached prefix still hits.
  - `dropOlderReasoning(messages)`: removes reasoning parts from every assistant message except the most recent one, which Anthropic needs alongside pending tool results.
- `executeAgentStep` / the loop in `executeAgent`, with `files` on:
  - Before each step after the first, estimate the request with `countRequestTokens(messages)`.
  - At 75 percent of the threshold, append one reminder per run: save anything you still need to the workspace, because older output will be dropped.
  - At the threshold, apply both functions with `keepFrom` at the start of the last step's response, and record `step.compacted = 'threshold'`.
  - On the first `isContextLengthError` from a step, compact the same way and retry that step once (`step.compacted = 'overflow'` on the retry). A second overflow in the run falls through to today's handling (`onContextLengthError`, `throwOnError`).
- `utils/retry.ts` already stops retrying on context-length errors, so the generic retry needs no change.
- During implementation, add a short note to `docs/plans/context-continuity.md` that these helpers and the option now exist and its cross-round compaction should reuse them.

### 7. Prompt caching with files on

Multi-step runs become likely with files, so the run's initial prompt (agent instructions, game context, game state) should be written to cache once and read on every later step. Without `files`, nothing changes.

Quota closure keeps the bash definition and static capability instruction unchanged. Remaining quota and closure notices live in the uncached continuation nudge and tool results. Other changes to the model, active tools, or cached instructions can still invalidate the prefix.

- Move `MAX_CACHE_BREAKPOINTS` and `markBreakpointOnLast` from `envoy/envoy.ts` to the existing `utils/models/cache-breakpoint.ts`, alongside `cacheBreakpoint`, so `infra/` does not import from `envoy/`. Envoy imports them from there; its strategy note stays in `envoy.ts`.
- `executeAgent` (`vox-execute.ts`): after `messages.push(...prepared.messages)`, when `host.files` is set, mark the last initial message as a breakpoint. Skip it if that message is already marked (live envoys often end on an anchor) or the request already has `MAX_CACHE_BREAKPOINTS`. The marker sits in the history, so it is byte-stable across steps. It is ignored by non-Anthropic providers, so no provider check is needed.
  - Anthropic family: step 1 writes the whole initial prompt; steps 2 and later read it. Tool traffic after the anchor is re-read each step, the same trade-off the envoy note already accepts.
- Claude Code: no change in this plan. Its system prompt behavior stays as it is today (see below), so the breakpoint does nothing there.
  - Already landed separately: `claudeCodeSystemMiddleware` (`claude-code-prompt.ts`) now turns every system message into a user message in place, with no merging. The provider already folded system text into the user turn, so the CLI system prompt is unchanged.
  - How the system prompt is set today: `convertToClaudeCodeMessages` collects system text but `doGenerate`/`doStream` drop it, so only `settings.systemPrompt` reaches the Agent SDK, and we never set it. The SDK turns that into `""` and sends it in the `initialize` control message. The CLI builds the request system prompt as billing header, then an identity line (`YAn`: "You are a Claude agent, built on Anthropic's Claude Agent SDK." for non-interactive runs without an append), then the custom prompt with empty entries filtered out. Prompt caching is on unless `DISABLE_PROMPT_CACHING*` is set.
  - Consequence: every step is a fresh CLI query whose whole prompt is one user text block, so nothing past the CLI's fixed prefix is reused between steps. Fixing that needs either the real system prompt (a behavior change we are avoiding) or session resume; both are left for a separate decision.

### 8. Telemetry, docs, tests

- `utils/telemetry/host-capabilities.ts`: `hostCapabilityTelemetryAttributes(model, files)` lists `read`/`write` from the context's files for any provider (`write` when any mount is writable) plus `web` for CLI providers. Non-CLI providers now emit `host.capability` when files are on.
- `web/routes/telemetry.ts`: skip the `workspaces` folder in the `/databases` scan.
- Local config (gitignored, done for the user, not committed): seat 0 `files: "write"` + `hostTools: ["Web"]`; seat 7 `files: "write"`, no `hostTools`.
- Docs: rewrite the host-tools paragraphs in `docs/developers/vox-agents/overview.md` (files setting, layout, read vs write, free workspace steps and the bash quota, nudge, auto compaction and `continuityThreshold`, caching with files on, Web-only CLI tools, cross-seat caveat) and the matching paragraph in `docs/players/configuration.md`, including the breaking `hostTools` change. Add one bullet on `files` to the Critical Conventions in `vox-agents/AGENTS.md`.
- Tests (Vitest, behavior not wording):
  - Update: `tests/mock/utils/providers/host-tools.test.ts`, `host-capability-prompt.test.ts` (move to match the new module), `codex.test.ts`, `tests/mock/utils/models.test.ts`, `tests/mock/utils/host-capability-telemetry.test.ts`, `tests/mock/utils/concurrency-batch-guard.test.ts`, `tests/mock/infra/continuation-nudge.test.ts`, `tests/mock/web/routes/telemetry-routes.test.ts` (workspace `.db` files are not listed).
  - `tests/mock/strategist/seat-config.test.ts`: `resolveSeatFiles` precedence, shorthand, invalid values and names.
  - Config-loading tests: a real root config's `files` value survives both `loadVoxConfig` and the final runtime config construction; seat and session precedence still applies.
  - New `tests/mock/utils/workspace.test.ts` against a temp telemetry dir: a write in `/workspace/game` lands on disk; a second `PlayerWorkspace` for the same player sees it; a different player does not; read mounts reject writes; a shared folder is visible from two games; escape attempts fail; guides are created once and never overwritten.
  - `seat-config.test.ts` also covers `quota` default and validation.
  - Step-loop tests: bash appended only with files and a non-empty tool set (`undefined` includes all registered tools; `[]` stays tool-less); bash remains offered after quota exhaustion but returns a failure without command execution; parallel calls admitted before closure may overshoot; nested and concurrent executions have independent allowances; the nudge carries the remaining count (checked through a controlled quota, not wording). Bash-only steps with quota remaining do not count toward `maxSteps` for the base agent, LiveEnvoy, and Negotiator; invalid bash attempts consume quota; repeated calls after closure hit `maxSteps`; empty, text-only, and mixed steps count; an invalid bash call without files counts as today; a malformed terminal call still retries; Briefer does not stop on a text-plus-bash step admitted before closure. Existing stop-check tests pass unchanged.
  - Compaction (`tests/mock/utils/message-history.test.ts` plus a step-loop case): old bash outputs are stubbed and the latest step's kept; non-bash results and messages before the anchor are unchanged; only the latest reasoning survives; inputs are not mutated; tool-result and retained-reasoning growth increase the request estimate; bash output growth alone crosses the reminder and compaction thresholds; one reminder at 75 percent; a first overflow compacts and retries, a second fails as today; without files an overflow behaves as today.
  - Caching: with files on, the last initial message gets one breakpoint and the count never exceeds `MAX_CACHE_BREAKPOINTS`; compare captured provider requests before and after quota exhaustion to verify the bash definition and cached instructions stay identical, with closure only in the uncached tail. Without files the request is unchanged. Envoy breakpoint tests keep passing after the move.

## Risks and open questions

- Windows behavior of the real-disk filesystems and mount containment are unverified until the spike. Containment failure blocks the plan.
- Each bash call is a full model round trip, which costs latency compared with CLI-internal tools. The prompt pushes batching, and caching keeps the repeated prefix cheap. The default quota of 20 is a starting point to tune from telemetry.
- Compaction stubs old bash output; an agent that never saved notes may re-run commands. The 75 percent reminder is the mitigation.
- Threshold compaction rewrites tool traffic after the cache anchor, so the tail after it is re-written to cache once.
- With files on, step 1 pays the cache-write premium on the whole initial prompt (1.25x on Anthropic) even when the run ends in one step.
- just-bash is not a VM. Network, Python, and JS stay off.
- Oracle replays a recorded `activeTools` list in a context without files, so a recorded `bash` call fails as an unknown tool. That matches replaying without the workspace.
- Shared folders written by two processes at once have no locking. Acceptable for notes.

## Verification

1. `npm run build:all` and `npm run test:all` from the repo root.
2. Manual: run the files-enabled config with `npm run strategist` for a few turns, once on a cheap OpenRouter model and once on Codex. Confirm `telemetry/workspaces/games/<game>-player-0/AGENTS.md` exists, notes appear, the strategist still finishes with `set-flavors` or `keep-status-quo`, and step spans show `bash` tool spans and `host.capability`. On an Anthropic-family model with stable tools and instructions, step 2 and later spans show `tokens.input.cached` covering the initial prompt, including after workspace closure.
3. Confirm host-tool validation throws for entries outside the `Web` whitelist, including `Read`, `Write`, and `everything`.
4. Run one seat with `files: { "game": "write", "quota": 2 }` and a low `continuityThreshold` (for example 20,000) on a cheap model. Bash stays listed after the quota is used, but further calls return a failure and leave workspace files unchanged. Further bash-only steps count toward `maxSteps`, and a step span shows `step.compacted` when output growth crosses the threshold.

## Out of scope

- A UI editor for `files`.
- Network (`curl`) or Python/JS inside just-bash.
- A configurable workspace root.
- The sibling plan's cross-round continuity (carried history, `compact-context` tool, handoff notes).
- A moving breakpoint that also caches tool traffic within a run.
- Migrating notes from the old `%TEMP%/vox-claude-code` and Codex proxy folders.
