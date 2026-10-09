# Handoff: Decisions, strategic routing and headless VD

Updated 2026-10-09. This is the entry point for continuing this fork on another Windows PC without the original chat. Read the root and relevant component `AGENTS.md` before changing code.

## Repositories and status

| Repository / branch | Completed work | Verified code revision |
| --- | --- | --- |
| [L1TTL3H0rSE/vox-deorum](https://github.com/L1TTL3H0rSE/vox-deorum), `codex/strategic-routing` | Native OpenAI Decisions evaluator and opt-in strategic routing, including the earlier bounded projection and merged upstream changes | `53020ebd` Decisions; `fac702d9` routing |
| [L1TTL3H0rSE/civ5-overhaul](https://github.com/L1TTL3H0rSE/civ5-overhaul), `codex/vd-headless-smoke` | Read-only prerequisite checker, three Python tests and proposed smoke contract | `cf7426b` |

The changes are in these branches. Cloning only the default branch does not select the VD implementation or the preflight checker. Later documentation commits may follow the code revisions above.

**The real VD headless smoke is BLOCKED / NOT RUN.** There is no complete VD headless launcher or qualified host/DLL integration in this work. Mock tests prove software contracts, not gameplay or model quality.

The engine repository has advanced separately: on 2026-10-09, remote `main` was `d1f6d64`, with x64, interactive-client and B1/B2 work described in its current `HANDOFF.md`. The preflight branch still starts at `0ea0b35`. For new engine work, fetch and read the latest `main` handoff and `civ5-plan.md`, create an isolated checkout from that state, and bring across the preflight change if useful. Do not replace the other agent's active checkout with our older branch. The engine's B1/B2 agent has its own control boundary; its results do not qualify the VD bridge/MCP connection.

## Clone, install and check the VD sources

Use Windows, Git and Node.js at least 22.23.3. The recorded development environment was Node 24.19.0 / npm 11.1.0. Run these commands in a new directory:

```powershell
git clone --branch codex/strategic-routing https://github.com/L1TTL3H0rSE/vox-deorum.git vox-deorum-vd
cd vox-deorum-vd
npm ci --include=dev
npm --prefix vox-agents/ui ci --include=dev
npm run build:all
npm run test:all
```

The root install covers all three Node workspaces. The UI has its own lockfile and needs the second install. These build/mock commands need no model credential or DLL build. `build:all` also builds the UI; `test:all` includes its tests. The existing setup guide describes [running the game-backed stack](setup.md#running-the-stack); that additionally needs the game/mod/DLL installation and local service settings.

For C++ work, initialize the pinned submodule separately with `git submodule update --init --recursive civ5-dll`. At `fac702d9` its pin is `ec01e3f8e3e9931a620c504e007651525c1ae051`. This fetches sources, not a ready DLL or toolchain. Follow [DLL build documentation](civ5-dll/building.md) for the chosen profile. Avoid `scripts/manual-update.cmd` on these feature branches: it resets the checkout to `main`.

Provider credentials and `vox-agents/config.json` are local and excluded from Git. `vox-agents/.env.default` is the tracked credential template. Configure a provider only when explicitly proceeding to model calls. Decisions uses `OPENAI_API_KEY`; the no-LLM smoke does not need it.

## Implementation to preserve

- Decisions is selected explicitly as `openai-decisions/gpt-6-luna` through the existing evaluator aliases and seat overrides. Other provider paths retain their behavior. Native calls have bounded retries, a total deadline, cancellable admission and usage accounting on failures. See [overview](vox-agents/overview.md) and [observability](vox-agents/observability.md).
- Strategic routing uses the existing `triage` opt-in and `createTriage`. It runs before the pacing gate on the simple strategist family. Full reviews and configured interruptions require at least `default`; small decisions cannot postpone the full-review deadline. Cancellation rejects late evaluator answers.
- The [projection](vox-agents/evaluation-projection.md) is bounded, read-only and tied to game/player/observation time. Mandatory choices, deadlines and exhaustive risks remain unknown. A `skip` recommendation therefore falls back to the existing cadence. This version does not claim fewer calls than ordinary pacing or improved playing strength. See [routing policy](vox-agents/evaluators.md#per-turn-strategic-routing).
- A route is reused across event-window retries. Evaluator usage counts on skipped and failed turns; missing usage carries an explicit incomplete flag. Do not replace these semantics with prompt-only safeguards or infer missing observations as zero.

## What must be available on the engine PC

Use private copies of runtime inputs. Record the source revision/profile and SHA256 of the files actually used; paths and old hashes in engine handoffs are evidence to recheck, not portable configuration.

| Input | Requirement |
| --- | --- |
| Host executable and VD DLL | A compatible architecture, compiler/ABI and source profile. The original host uses ordinary VP, while VD pins its own DLL fork with `CvConnectionService`. Compatibility is unverified. The newer x64 host also needs separate VD qualification. |
| Modded gameplay DB and localization DB | The engine machine's `host/work/modded.db` and `host/work/localization.db` may supply the starting copies. Check their profile/schema and VD activation. `IPC_CHANNEL` and required `EVENTS_*` options must be enabled. Adding these flags alone does not prove full schema compatibility. |
| Fixture save or qualified deterministic scenario | Must match the chosen DLL/data profile. The earlier proposed smoke uses the Austria fixture recorded in the engine handoff. |
| Game/runtime dependencies | Follow the selected engine profile and its current build/runtime instructions. The original preflight checks Win32 game libraries; it does not qualify the new x64 profile. |
| Source/toolchain for a rebuild | The original x86 recipe needs VP sources, LLVM 19 and SDK 7.0/VC9 outside Git. For current x64 builds, use that branch's `host/build_x64.py` and current handoff. Do not assume the old recipe applies unchanged. |

On the development PC, the original host executable, VD DLL output, engine DB copies, toolchain and Austria fixture were absent. The installed Civ V libraries and a localization DB existed; its gameplay cache had no `CustomModOptions` table and was unsuitable. These are machine-local findings, not claims about the engine PC.

The checker is `stand/vd_preflight.py` on `civ5-overhaul` branch `codex/vd-headless-smoke`. `python -m unittest stand.test_vd_preflight` runs its pure tests. `python stand/vd_preflight.py --help` lists the explicit input paths, including `--vd-options-sql` pointing at this VD checkout's `civ5-mod/SQL/VoxDeorum_Options.sql`. The checker opens SQLite read-only and always reports `full_smoke_execution: NOT_RUN`. Even exit 0 only means its prerequisites are present; ABI, callbacks and protocol remain unverified.

MCP needs its own private Documents directory layout: under `DB_DOCUMENTS_PATH`, place the compatible copies at `My Games/Sid Meier's Civilization 5/cache/Civ5DebugDatabase.db` and `Localization-Merged.db`. The setting points to the Documents root, not to a DB file. Its loader also waits for required mod tables such as `GreatPersons`; the preflight's option check does not cover the entire MCP schema. Its generated per-game knowledge store is separate. See [MCP configuration](mcp-server/configuration.md) and `mcp-server/src/database/manager.ts`.

## Next task and acceptance

Continue only the no-LLM VD integration in an isolated engine checkout after reconciling its latest handoff. Inventory available artifacts first, choose a compatible host/DLL profile, then address the real connection: named pipe, Lua callbacks and command processing on the game thread while paused. Preserve player visibility, game identity and observation time. Existing engine results, mock bridges, direct debug commands and zero-test tiers cannot establish this connection.

Use the official bridge-service and MCP processes with private data paths, and a fixed MCP client. The proposed smoke must observe: DLL connection and game identity; a requested player's safe paused turn with repeated reads still answering; one `keep-status-quo` action with callback evidence; `resume-game` followed by actual turn progress. Bound each operation, retain request/result/event evidence and attempt resume in `finally`. The earlier detailed contract is in `civ5-overhaul/stand/vox-boundary.md`; recheck its pinned 2026-10-07 source assumptions against the selected revisions.

No paid model calls, GUI game launch, installed-mod replacement, live DB mutation, fixture/pin rewriting or changes in the other agent's checkout are part of this smoke handoff. Coordinate shared engine processes using the latest engine rules. Once the smoke passes, report its exact revisions, hashes and evidence before proceeding to model gameplay or performance evaluation.

## Recorded verification

At `fac702d9`, the full build passed and the root mock suite passed **3124 tests with 16 skipped** (bridge 93, MCP 430, agents 2310, UI 291). Final routing checks passed 27 tests and TypeScript compilation. The Python preflight suite passed 3 tests. No live Decisions API call or real VD headless smoke was performed. Local logs and `host/work/vd-preflight-current.json` are ignored output, not files available from a clone.

On 2026-10-09, a fresh local clone of the published `fac702d9` revision passed both clean dependency installs, `build:all` and `test:all` with the same totals. It had no copied `.env`, agent configuration, submodule checkout or game assets. This verifies setup from tracked files on this Windows PC; execution on the destination PC remains to be checked.

Agent startup instruction: read this document, repository instructions, and the latest engine `HANDOFF.md`; report the selected branches/revisions and available runtime inputs, then continue the isolated no-LLM smoke without repeating the completed Decisions/routing implementation.
