# just-bash workspace for all agents

This plan gives every agent optional file access through a simulated bash, and removes the Codex and Claude Code filesystem tools. Paths are relative to `vox-agents/src/` unless they start with `vox-agents/` or `docs/`. Status: Steps 0 to 8 done, including the Node 22.23.3 requirement. The manual checks under Verification are still open.

## Context

Today only Codex and Claude Code agents can touch files. The model option `hostTools: ["Read"|"Write"|"Web"]` maps to each CLI's own file tools (Claude Code Read/Glob/Grep/Write/Edit, Codex sandbox levels), with one temp folder per provider per player. Every other provider gets nothing, and notes do not follow a switch between Codex and Claude Code.

We will give every tool-using agent of a seat, on any provider, a `bash` tool backed by [just-bash](https://github.com/vercel-labs/just-bash): a simulated bash with a virtual filesystem whose mounts map to real folders. Codex and Claude Code lose their filesystem tools and working folders; their native `Web` stays.

## Goal and success criteria

- A seat setting `files` turns file access on for every tool-using agent of that seat, whatever the provider.
- All agents of one player in one game share one folder: `<telemetryDir>/workspaces/games/<gameID>-player-<playerID>/`.
- Optional named shared folders persist across games: `<telemetryDir>/workspaces/shared/<name>/`.
- Agents get a `bash` tool, a system prompt on how to use the workspace, and a closing reminder that counts down the steps left for the final decision.
- Bash joins each tool-using agent's declared tools and stays declared for the whole run, so the declarations and the cached prefix do not change between steps. Runs an agent restricts on purpose, such as a live envoy's greeting, leave it out.
- Without `files`, step limits, the closing reminder, and compaction stay as today.
- With `files`:
  - Workspace work and the final decision share one step budget: the agent's step limit becomes `files.quota` unless its own `maxSteps` is higher. Commands are cheap and model steps are not, so agents are pushed to issue parallel calls or one script.
  - A long run compacts itself: old bash output is dropped once the request nears a size threshold, or once after a context-length error.
  - Anthropic-family requests mark the run's initial prompt (instructions plus game state) for caching, so eligible later steps can reuse it. Cache expiration and provider admission can still cause a fresh write. Claude Code caching is left as an open question (Step 7).
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
  "quota": 20                       // step limit of one agent execution, unless maxSteps is higher (default 20)
}
```

The size threshold for compaction is a model option, `options.continuityThreshold` (default 300,000 tokens for Claude Code, Codex, OpenAI, and Anthropic models, 100,000 otherwise), the same name the sibling plan `docs/plans/context-continuity.md` defines, so both plans share one knob.

Virtual layout seen by the agent (cwd `/workspace`):

| Virtual path | Real folder | Lifetime |
| --- | --- | --- |
| `/workspace/game/` | `<telemetryDir>/workspaces/games/<gameID>-player-<playerID>/` | One game, one player |
| `/workspace/shared/<name>/` | `<telemetryDir>/workspaces/shared/<name>/` | Across games and seats |
| `/tmp/` | `<telemetryDir>/workspaces/scratch/<gameID>-player-<playerID>/` | One game, one player; always mounted |

- `"read"` mounts just-bash `OverlayFs({ root, readOnly: true, mountPoint: '/' })`; `"write"` mounts `ReadWriteFs({ root })`, as does `/tmp`. Roots are canonicalized with `fs.realpathSync.native` after the folder is created. Each command gets a fresh `InMemoryFs` base, so files outside the mounts last for one command only.
- Shared names must match `^[a-z0-9][a-z0-9_-]*$`. Validation errors name the config path, like `resolveSeatTriage`.
- Caveat to document: two seats of the same game writing one shared name can pass information to each other. Users avoid that with different names per seat or read-only access.

## Current state

- Policy: `host-tools.ts` (`vox-agents/src/utils/models/providers/`) validates `hostTools`, creates per-provider working dirs, seeds `AGENTS.md`/`CLAUDE.md` (`seedHostWorkspaceGuide`, `getHostWorkspaceGuide`), and defines `isHostCapabilityProvider` from `hostWorkspaceGuideFiles`.
- Claude Code: `claude-code.ts` `claudeCodeMetaToolExpansion`, `expandClaudeCodeTools`, `buildClaudeCodeModel` (sets `cwd`, `tools`, `allowedTools`, `permissionMode`).
- Codex: `codex.ts` `buildCodexProviderOptions(model, runtimeIdentity?, previousResponseId?)` maps access to `sandbox` and `cwd`. The web-only path already runs with `sandbox: 'disabled'` and no `cwd`.
- Prompt: `host-capability-prompt.ts` `hostCapabilityInstruction` / `hostCapabilityMiddleware`, installed outermost in `getModel` (`utils/models/models.ts`) for CLI providers only. It uses `clientFunctionToolNames` from `required-tool-choice.ts`.
- `models.ts`: `getModel(config, { workingDirId, ... })`, `buildProviderOptions(model, runtimeIdentity?, previousResponseId?)`, and a re-export of `ModelRuntimeIdentity`.
- Step loop: `executeAgentStep` in `infra/vox-execute.ts` builds `runtimeIdentity`, records `hostCapabilityTelemetryAttributes`, and emits provider-executed tool spans for CLI providers. Tool declarations, per-step narrowing, and the closing reminder are described in `docs/developers/vox-agents/prompts.md`.
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
- Other readers of host policy: `utils/models/concurrency.ts` (batch-mode guard via `isHostCapabilityProvider`), `utils/telemetry/host-capabilities.ts` (`host.capability` span attribute).
- The web telemetry route (`web/routes/telemetry.ts`, `/databases`) recursively lists every `.db` under `telemetry/`, so a `sqlite3` file an agent writes in a workspace would show up as a game database.
- The only local config using `hostTools` is `vox-agents/configs/gpt-5.6-luna-tools-standard-fixed-per-5.json` (gitignored, not a repo deliverable).

## Approach

Use `just-bash` directly (one dependency), wrapped with `createSimpleTool`. We skip the `bash-tool` package: it adds `readFile`/`writeFile` tools we do not need and a second peer dependency on `ai`, and our wrapper already handles tracing, key normalization, and per-context parameters.

The `bash` tool is registered only when the context's `files` setting is on, and the loop adds it to each tool-using agent's declared tools. The step budget is covered in Step 5.

## Steps

### 0. Spike (done)

`just-bash` 3.6.0 is installed in `vox-agents` (`npm install just-bash -w vox-agents`). A throwaway script on Windows 11 checked the four questions below.

**Blocker found: Node older than 22.17.0 breaks `ReadWriteFs` writes on Windows.** Every write stages a temp file, then compares `dev`/`ino` from the open handle's `stat` with a later `lstat` by path. On Node 22.12.0 to 22.16.x, Windows `lstat` returns `dev: 0` while handle `stat` returns the volume serial, so every write fails with `EACCES: replacement staging entry changed`. Node 22.17.0 and later (checked up to 22.23.3 and 24.21.0) report matching values. just-bash 3.3.0 and later all have these checks; 3.1.0 has none but lacks the newer anti-tampering fixes.

| Node | `lstat` `dev` matches handle `stat` |
| --- | --- |
| 22.12.0 (bundled by the release installer), 22.15.1 (current dev machine), 22.16.0 | No, writes fail |
| 22.17.0, 22.17.1, 22.18.0, 22.20.0, 22.22.0, 22.23.3, 24.21.0 | Yes |

With Node 22.23.3, everything else passed:

1. **Mounts.** `ReadWriteFs` and `OverlayFs` accept a canonical Windows `root` under `MountableFs` mount points. Writes, heredocs, and `ls`/`cat`/`rg`/`jq`/`sqlite3` work, including on a `/tmp` mounted on disk. `OverlayFs` needs `mountPoint: '/'` when mounted inside `MountableFs`; without it the real files show up under `home/user/project` inside the mount.
2. **Containment.** `..` past the mount, Windows absolute paths (`C:\...`, `C:/...`, `/C:/...`), and `cp` from a host path all report "No such file". `ln -s` fails with "Operation not permitted". A real symlink placed inside the root is not followed, and a real junction to the parent is rejected with `EACCES ... resolves outside sandbox`. `echo > game/../../x` writes to the virtual in-memory base, not the disk. Nothing reached the disk outside a root.
3. **Concurrency.** Two concurrent `exec` calls on one `Bash` each keep their own `cd` and variables, and 200 appends from one finished intact. Step 2 still builds a `Bash` per command, so files outside the mounts never outlive a command, while the mount filesystems are shared.
4. **Abort.** An `AbortSignal` stops a script that yields (`sleep 10` stopped after 300 ms with exit 124). A tight CPU loop never yields to the timer, so the abort does not fire; the default `maxCommandCount` limit (100,000) ends it with exit 126 in about 1 to 5 seconds.

Other findings that shape Step 2:

- A write to a read-only mount makes `exec` reject with an `EROFS` error instead of returning a non-zero exit code. The same happens for a write through a junction that resolves outside the root. The tool must catch rejections from `exec` and return them as `stderr` with exit code 1.
- `python3`, `js-exec`, `curl`, and `node` are absent with default options.
- `mv` between mounts, such as from `/workspace/game` to `/tmp`, copies the file and deletes the original. That is ordinary `mv` behavior, so no special handling.

**Decision: require Node 22.23.3.** Done in this step:

- The `engines` field in the root, `bridge-service`, and `mcp-server` `package.json` files is `>=22.23.3`.
- `scripts/utilities/build-installer.cmd` bundles portable Node 22.23.3 and replaces an existing `node/` folder that holds a different version.
- `scripts/install.cmd` downloads Node 22.23.3 when no system Node is found.
- `docs/developers/setup.md` and `docs/developers/releasing.md` name the new version.

### 1. Config types and resolution

- `types/config.ts`:
  - `export type FileAccess = 'read' | 'write';`
  - `export interface FilesConfig { game?: FileAccess | false; shared?: Record<string, FileAccess>; quota?: number; }`
  - `export type FilesSetting = false | FileAccess | FilesConfig;`
  - Add `files?: FilesSetting` next to `triage` on `VoxAgentsConfig`, the session config, and `PlayerConfig`.
- `utils/config/diff.ts`: add `'files'` to `topLevelKeys`.
- `utils/config.ts`: copy `files: fileConfig.files` into the object returned by `loadConfig`, next to `triage`.
  - `export type ResolvedFilesConfig = Required<FilesConfig>;`
- `strategist/seat-config.ts`: `resolveSeatFiles(playerConfig, sessionFiles?, slot?): ResolvedFilesConfig | undefined`. Same precedence as `resolveSeatTriage`; expands the shorthand; validates keys, values, shared names, and `quota` (a positive integer); fills `quota` with `defaultFilesQuota` (20); returns `undefined` when nothing is mounted.
- `strategist/vox-player.ts`: accept `files` in `VoxPlayerOptions`; set `this.context.files = resolveSeatFiles(...)` next to triage.
- `strategist/strategist-session.ts`: pass `files: this.config.files` where it passes `triage`, and call `resolveSeatFiles` in the per-seat preflight so bad config fails at session start.
- `infra/vox-context.ts`: `public files?: ResolvedFilesConfig;` with a comment like the `triage` one.

### 2. Workspace and bash tool

- New `utils/workspace/player-workspace.ts`:
  - `workspaceRoot()` returns `<config.telemetryDir || 'telemetry'>/workspaces`, resolved from cwd.
  - `class PlayerWorkspace(files, gameID, playerID)`. The constructor lists the mounts without touching disk and rejects a game ID or shared name that cannot name a folder. Each `exec` checks `process.versions.node` and, below 22.17.0, returns an error result asking the user to upgrade Node instead of mounting anything. The first `exec` creates the real folders, seeds guides, and builds the mount filesystems (per Config design, including `/tmp`). Every `exec` then builds its own `MountableFs` over those mounts with a fresh `InMemoryFs` base, and its own `Bash` with `cwd: '/workspace'`, network and Python/JS off, default limits. A fresh shell costs about 5 ms.
  - `exec(command, signal)` returns `{ stdout, stderr, exitCode }`, each stream capped (8,000 chars, with a `[truncated N chars]` marker). A rejected `exec` (for example `EROFS` from a write to a read-only mount, or `EACCES` from a path that resolves outside a root) becomes `{ stdout: "", stderr: <message>, exitCode: 1 }`. Abort only stops scripts that yield; CPU-bound loops are ended by the default `maxCommandCount`.
  - Guide seeding: copy the create-once logic from `seedHostWorkspaceGuide` (`flag: 'wx'`, ignore `EEXIST`, log other errors) here; Step 3 deletes the original. Seed `AGENTS.md` at each writable game or shared root, not in scratch. The game guide keeps today's content (notes vs snapshots; observations vs inferences vs plans; current tools override stale notes; no untrusted text in the guide) minus the CLI shell-policy section. The shared guide says the folder outlives the game and is seen by other seats and games, so it holds generalized lessons and reusable references, never current-game state.
- `VoxContext`: cache `PlayerWorkspace` instances by `gameID-playerID` so all agents of a seat share one.
- New `utils/tools/bash-tool.ts`:
  - `bashToolName = 'bash'` (defined in `tool-names.ts` so provider middleware can name it).
  - `createBashTool(context)` via `createSimpleTool`. Name `bash`, input `{ Command: string }`. The description lists the mounts with their access and the main commands (ls, cat, grep, rg, sed, awk, find, jq, sqlite3, tee, heredocs), says each round of bash calls uses a step of the budget, and says to issue independent commands as parallel calls or one script.
  - Execute resolves the workspace from `parameters.gameID`/`playerID`, turns a workspace that cannot be created into a failure result, and passes `context.currentSignal()`.
- `VoxContext.registerAgentTools`: when `this.files` is set, register `this.tools.bash = createBashTool(this)`.
- Tests: `tests/mock/utils/workspace.test.ts` and `tests/mock/utils/tools/bash-tool.test.ts`. The tests that write to disk skip on Node older than 22.17.0.

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

### 5. Step budget and reminder (done)

With `files` on, one step budget covers workspace work and the final decision. Without files, every limit stays as today.

- `infra/vox-agent.ts`:
  - `stepLimit(context)` returns `Math.max(maxSteps, files.quota)` when files are on, else `maxSteps`.
  - `reachedStepLimit(allSteps, context)` is the shared hard ceiling: it logs a warning and returns true once the limit is used. The base `stopCheck`, `LiveEnvoy`, `Negotiator`, and `Briefer` all end through it. `retriesMalformedTerminal` takes the context and compares against `stepLimit`.
  - `Telepathist` drops its copy of the base stop check and sets `maxSteps = 50`.
  - `Envoy.recordStep` holds the thread-recording half of `Envoy.stopCheck`, so `LiveEnvoy` records without running (and logging) the base check.
- `Briefer.stopCheck` ignores text from a step that also calls bash, so "checking notes" plus a bash call does not end the briefing.
- The base `VoxAgent.getRunTools`: when the context registered bash, add it to a non-empty `getActiveTools()` list. `undefined` already means all registered tools; an empty list stays empty, so `toolChoice` is unchanged. Overrides that restrict a whole run (a live envoy's greeting, a telepathist's special message) leave bash out. A `prepareStep` list is not extended, so removing bash there works like removing any other tool.
- The bash closure (`bashOpen`, `bashStepsUsed`) is gone: the step limit already bounds bash.
- Reminders:
  - The capability prompt and the bash description say each round of bash calls uses a step of the budget, without a number, so they stay byte-stable.
  - With files on, `executeAgentStep` passes `stepsLeft = stepLimit - steps so far` to `continuationNudge`, and the closing reminder template (`buildClosingReminder` in `utils/prompts/closing-reminder.ts`) adds a steps-left line on every step, or a last-step line at 1.
- Tests: `tests/mock/context/vox-execute-step-budget.test.ts` (quota raises the limit, a higher `maxSteps` wins, no change without files, countdown per step, bash declared only with files, an empty list stays empty, Briefer ignores text next to bash).

### 6. Auto compaction within a run (done)

Pulled from the sibling plan `docs/plans/context-continuity.md` (threshold, 75 percent reminder, one overflow retry, older-reasoning removal), scoped to a single run because that plan's carried history does not exist yet. Only runs with `files` compact; others keep today's overflow behavior. Workspace notes are what make dropping old output safe.

- `utils/models/models.ts` (or a small `utils/models/thresholds.ts`): `continuityThreshold(model)` reads `options.continuityThreshold`, default 300,000 for Claude Code, Codex, OpenAI, and Anthropic models (including Claude on Vertex and `anthropic/` or `openai/` names on routers) and 100,000 otherwise, warns and falls back on a non-positive or non-finite value. Add the option to `LLMConfig` with a doc comment.
- `utils/models/token-counter.ts`: add `countRequestTokens(messages)` for compaction decisions. Include text, tool names and inputs, serialized tool-result outputs (including errors), retained reasoning, and message overhead. Keep the existing reasoning-only and visible-output counters used by telemetry unchanged. This remains a local estimate, not an exact provider token count.
- New `utils/prompts/message-history.ts` (the module the sibling plan names), pure functions on copies:
  - `compactWorkspaceTraffic(messages, keepFrom)`: replaces the output of every `bash` tool result before index `keepFrom` with a short stub saying the output was dropped and to re-run the command or read notes. Calls stay, so call/result pairs remain valid. Messages before the cache anchor and all non-bash traffic are untouched, so the cached prefix still hits.
  - `dropOlderReasoning(messages)`: removes reasoning parts from every assistant message except the most recent one, which Anthropic needs alongside pending tool results.
- `executeAgentStep` / the loop in `executeAgent`, with `files` on:
  - Before each step after the first, estimate the request with `countRequestTokens(messages)`.
  - At 75 percent of the threshold, append one reminder per run: save anything you still need to the workspace, because older output will be dropped.
  - At the threshold, apply both functions with `keepFrom` at the start of the last step's response, and record `step.compacted = 'threshold'`. Compaction waits until a step after the reminder, so a step that jumps straight past the threshold is reminded first. Bash output and reasoning in the run's initial messages are never touched.
  - On the first `isContextLengthError` from a step, compact the same way and retry that step once inside the same step span, reusing its prepared configuration (`step.compacted = 'overflow'`, and `step.messages` becomes the retried request). This emergency path does not wait for the reminder. A second overflow in the run falls through to today's handling (`onContextLengthError`, `throwOnError`).
- `utils/retry.ts` already stops retrying on context-length errors, so the generic retry needs no change.
- During implementation, add a short note to `docs/plans/context-continuity.md` that these helpers and the option now exist and its cross-round compaction should reuse them.

### 7. Prompt caching with files on

Multi-step runs become likely with files, so mark the run's initial prompt (agent instructions, game context, game state) for reuse on later eligible steps. Without `files`, this extra initial-message breakpoint is not added.

The bash definition and capability instruction carry no step counts. The steps-left countdown lives in the uncached tail. Changes to model, tool choice, output schema, reasoning settings, host capabilities, or cached instructions can still invalidate some or all of the prefix. Stable definitions preserve cache eligibility; they do not guarantee a cache hit.

- Move `MAX_CACHE_BREAKPOINTS` and `markBreakpointOnLast` from `envoy/envoy.ts` to the existing `utils/models/cache-breakpoint.ts`, alongside `cacheBreakpoint`, so `infra/` does not import from `envoy/`. Envoy imports them from there; its strategy note stays in `envoy.ts`. Keep the existing five-minute TTL and correct that module's stale one-hour comment.
- `executeAgent` (`vox-execute.ts`): after `messages.push(...prepared.messages)`, when `host.files` is set, mark the last initial message as a breakpoint. Skip it if that message is already marked (live envoys often end on an anchor) or the request already has `MAX_CACHE_BREAKPOINTS`. The marker sits in the history, so it is byte-stable across steps. It is ignored by non-Anthropic providers, so no provider check is needed.
  - Anthropic family: when eligible, step 1 writes the initial prompt and later steps read it within its TTL. Expiration or other admission failures may require another write. Tool traffic after the anchor is re-read each step, the same trade-off the envoy note already accepts.
- Claude Code: retain its current system prompt behavior (see below), so the breakpoint does nothing there.
  - Already landed separately: `claudeCodeSystemMiddleware` (`claude-code-prompt.ts`) now turns every system message into a user message in place, with no merging. The provider already folded system text into the user turn, so the CLI system prompt is unchanged.
  - How the system prompt is set today: `convertToClaudeCodeMessages` collects system text but `doGenerate`/`doStream` drop it, so only `settings.systemPrompt` reaches the Agent SDK, and we never set it. The SDK turns that into `""` and sends it in the `initialize` control message. The CLI builds the request system prompt as billing header, then an identity line (`YAn`: "You are a Claude agent, built on Anthropic's Claude Agent SDK." for non-interactive runs without an append), then the custom prompt with empty entries filtered out. Prompt caching is on unless `DISABLE_PROMPT_CACHING*` is set.
  - Consequence: every step is a fresh CLI query whose whole prompt is one user text block, so nothing past the CLI's fixed prefix is reused between steps. Fixing that needs either the real system prompt (a behavior change we are avoiding) or session resume; both are left for a separate decision.

### 8. Telemetry, docs, tests

- `utils/telemetry/host-capabilities.ts`: `hostCapabilityTelemetryAttributes(model, files)` lists `read`/`write` from the context's files for any provider (`write` when any mount is writable) plus `web` for CLI providers. Non-CLI providers now emit `host.capability` when files are on.
- Done in Step 2: `web/routes/telemetry.ts` skips the top-level `workspaces` folder in the `/databases` scan.
- Local config (gitignored, done for the user, not committed): seat 0 `files: "write"` + `hostTools: ["Web"]`; seat 7 `files: "write"`, no `hostTools`.
- Docs: the `files` setting, folder layout, access, quota, and cross-seat caveat already have a section in `docs/players/configuration.md` and a paragraph in `docs/developers/vox-agents/overview.md`. Rewrite the host-tools paragraphs there (step budget, steps-left reminder, auto compaction and `continuityThreshold`, caching with files on, Web-only CLI tools, cross-seat caveat) and the matching paragraph in `docs/players/configuration.md`, including the breaking `hostTools` change. Add one bullet on `files` to the Critical Conventions in `vox-agents/AGENTS.md`.
- Tests (Vitest, behavior not wording):
  - Update: `tests/mock/utils/providers/host-tools.test.ts`, `host-capability-prompt.test.ts` (move to match the new module), `codex.test.ts`, `tests/mock/utils/models.test.ts`, `tests/mock/utils/host-capability-telemetry.test.ts`, `tests/mock/utils/concurrency-batch-guard.test.ts`, `tests/mock/infra/continuation-nudge.test.ts`, `tests/mock/web/routes/telemetry-routes.test.ts` (workspace `.db` files are not listed).
  - `tests/mock/strategist/seat-config.test.ts`: `resolveSeatFiles` precedence, shorthand, invalid values and names.
  - Config-loading tests: a real root config's `files` value survives both `loadVoxConfig` and the final runtime config construction; seat and session precedence still applies.
  - Done in Step 2: `tests/mock/utils/workspace.test.ts` against a temp telemetry dir: a write in `/workspace/game` lands on disk; a second `PlayerWorkspace` for the same player sees it; a different player does not; read mounts reject writes; a shared folder is visible from two games; escape attempts fail; guides are created once and never overwritten; `/tmp` lasts for one player through the game and nothing else survives a command.
  - Done in Step 1: `seat-config.test.ts` also covers `quota` default and validation.
  - Done in Step 5: step-budget tests in `vox-execute-step-budget.test.ts`. Existing stop-check tests pass unchanged.
  - Compaction (`tests/mock/utils/message-history.test.ts` plus a step-loop case): old bash outputs are stubbed and the latest step's kept; non-bash results and messages before the anchor are unchanged; only the latest reasoning survives; inputs are not mutated; tool-result and retained-reasoning growth increase the request estimate; bash output growth alone crosses the reminder and compaction thresholds; one reminder at 75 percent; a first overflow compacts and retries, a second fails as today; without files an overflow behaves as today.
  - Caching: with files on, the last initial message gets one breakpoint and the count never exceeds `MAX_CACHE_BREAKPOINTS`; compare captured provider requests across steps to verify the bash definition and cached instructions stay identical, with the countdown only in the uncached tail. Without files no extra breakpoint is added; stable declarations and execution guards still apply. Envoy breakpoint tests keep passing after the move.

## Risks and open questions

- `ReadWriteFs` writes fail on Windows with Node older than 22.17.0 (see Step 0). The repo now requires 22.23.3, but a developer or player on an older system Node still gets only an `npm` warning, so the workspace checks the version itself. Containment passed the spike on Windows.
- Each bash step is a full model round trip, which costs latency compared with CLI-internal tools. The tool description pushes parallel calls and batching, and caching keeps the repeated prefix cheap. The default budget of 20 steps is a starting point to tune from telemetry.
- Compaction stubs old bash output; an agent that never saved notes may re-run commands. The 75 percent reminder is the mitigation.
- Threshold compaction rewrites tool traffic after the cache anchor, so the tail after it is re-written to cache once.
- With files on, step 1 pays the cache-write premium on the whole initial prompt (1.25x on Anthropic) even when the run ends in one step.
- just-bash is not a VM. Network, Python, and JS stay off.
- Oracle replays a recorded `activeTools` list in a context without files, so a recorded `bash` call fails as an unknown tool. That matches replaying without the workspace.
- Shared folders written by two processes at once have no locking. Acceptable for notes.

## Verification

1. `npm run build:all` and `npm run test:all` from the repo root.
2. Manual: run the files-enabled config with `npm run strategist` for a few turns, once on a cheap OpenRouter model and once on Codex. Confirm `telemetry/workspaces/games/<game>-player-0/AGENTS.md` exists, notes appear, the strategist still finishes with `set-flavors` or `keep-status-quo`, and step spans show `bash` tool spans and `host.capability`. On an Anthropic-family model with a cache-eligible prompt, stable tools and instructions, and steps within the five-minute TTL, inspect `tokens.input.cached` for initial-prompt reuse across steps. Record misses and rewrites separately from definition stability.
3. Confirm host-tool validation throws for entries outside the `Web` whitelist, including `Read`, `Write`, and `everything`.
4. Run one seat with `files: { "game": "write", "quota": 8 }` and a low `continuityThreshold` (for example 20,000) on a cheap model. The closing reminder counts down from 8, the run ends by step 8, and a step span shows `step.compacted` when output growth crosses the threshold.

## Out of scope

- A UI editor for `files`.
- Network (`curl`) or Python/JS inside just-bash.
- A configurable workspace root.
- The sibling plan's cross-round continuity (carried history, `compact-context` tool, handoff notes).
- A moving breakpoint that also caches tool traffic within a run.
- Migrating notes from the old `%TEMP%/vox-claude-code` and Codex proxy folders.
