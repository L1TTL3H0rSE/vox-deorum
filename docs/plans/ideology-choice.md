# Let strategists choose their ideology

Strategists cannot choose their civilization's first ideology today. The game's AI picks Freedom, Order, or Autocracy at the start of a turn, before the strategist sees the choice. This plan adds a pre-selection slot: the strategist picks an ideology ahead of time, and the game adopts that pick when ideologies unlock.

## Goal and success criteria

The change is done when all of the following hold:

1. From the Industrial era until the player adopts an ideology, `get-options` lists every ideology the player could adopt, labeled `<Name> (New Ideology)`. It also shows the current pre-selection.
2. Calling `set-policy` with an ideology name stores it in a new slot. This does not disturb the normal next-policy slot.
3. When `CvPolicyAI::DoChooseIdeology` runs, it adopts the stored ideology if it is still valid. Otherwise it falls back to the existing AI logic.
4. Players that never pre-select behave exactly as before. This includes the null strategist and players without Vox Deorum.

## Current state

- **When the ideology gets picked.** `CvPlayer::doTurnPostDiplomacy` calls `DoChooseIdeology` for AI players when `IsTimeToChooseIdeology()` is true and the player has no ideology. `DoChooseIdeology` applies its rules in this order:
  1. the vassal rule (take the master's ideology)
  2. the team-leader rule
  3. scoring for Freedom, Order, and Autocracy
  4. the optional Heritage override (`MOD_ISKA_HERITAGE`)
  5. an adoption tail: `SetPolicyBranchUnlocked`, `LogBranchChoice`, the GEorGM trait, and the `PlayerAdoptPolicyBranch` Lua hook
- **Why the strategist misses the choice.** The strategist runs after `PlayerDoneTurn`, and the pick happens at the start of the next turn. Telemetry shows the gap. In game `ea6516f5`, player 1 saw no ideology among its options on turn 281. On turn 282 it already had Freedom and was only offered Freedom tenets.
- **Why the options list can't show ideologies.** `CvPolicyAI::ChooseNextPolicy` builds the options list, and it never includes ideology branches. `CvPlayerPolicies::CanUnlockPolicyBranch` returns false for `IsPurchaseByLevel` branches.
- **Why the existing slot can't hold an ideology.** `m_iNextPolicy` is a single slot that the next normal policy pick consumes. A forced ideology branch would fail validation there and be cleared silently.
- **Save format.** `CvPolicyAI::Serialize` has no versioning. `m_iNextPolicy` was added the same way.
- **Knowledge database.** There is one SQLite file per game, and resumed games reuse it. `mcp-server/src/knowledge/schema/setup.ts` creates tables with `ifNotExists` and has no column migrations.
- **Who reads the options list:**
  - `get-player-options.lua` collects the raw options.
  - `knowledge/getters/player-options.ts` maps IDs to names.
  - `tools/knowledge/get-options.ts` labels the entries.
  - `tools/actions/set-policy.ts` validates against `GetPossiblePolicies` and strips the suffix in parentheses.
  - `civ5-mod/UI/VoxDeorumHumanPanel.lua` parses the `(New Branch)` and `(Continuing X Branch)` suffixes.
  - `vox-agents/src/strategist/agents/null-strategist.ts` picks a random key from `Options.Policies` whenever no policy is queued.

## Approach

We add a second forced slot, `m_iNextIdeology`, to `CvPolicyAI`. The strategist fills it with `set-policy`, and `DoChooseIdeology` reads it right after the vassal rule.

**When the choice is open.** The choice is open while the player has no ideology, the current era is at least Industrial, and the player is not a vassal whose master already has an ideology. Every unlock trigger in Community Patch and Vox Populi (the era, the policy count, and factories) needs at least the Industrial era. So this window opens before the earliest possible unlock and closes when an ideology is adopted.

**Which rule wins:**

1. The vassal rule keeps top priority, because it is a game rule.
2. A valid pre-selection comes next. It overrides the team-leader rule, the scoring, and the Heritage override.
3. If the pre-selection is invalid at unlock time, the existing logic runs unchanged. Examples: `CanAdoptIdeology` returns false, or the conditions for Heritage no longer hold.

**Alternatives we rejected:**

- **Delay the AI pick by one turn for LLM players.** The DLL has no "LLM-controlled" flag. It would also cost every LLM player a turn of tenet benefits.
- **Reuse `m_iNextPolicy`.** Normal policy picks during the window would consume or block it.

## Steps

### 1. DLL (`civ5-dll/CvGameCoreDLL_Expansion2/`)

Mark every edit outside `CvConnectionService` with `// Vox Deorum:`.

**1a. `CvPolicyAI.h` / `CvPolicyAI.cpp`**
- Add `int m_iNextIdeology`.
  - Initialize it to `-1` next to `m_iNextPolicy`.
  - Serialize it in `CvPolicyAI::Serialize` right after `m_iNextPolicy`.
- Add `SetNextIdeology(int)` and `GetNextIdeology()`, matching the accessors for the policy slot.
- Add `bool IsIdeologyChoiceValid(CvPlayer* pPlayer, PolicyBranchTypes eBranch)`. It returns true only when all of these hold:
  - the branch is `IsPurchaseByLevel` and not already unlocked
  - the player has no ideology
  - `CanAdoptIdeology(eBranch)` is true
  - for Heritage only: `MOD_ISKA_HERITAGE` is on, and the religion check from `DoChooseIdeology` passes
- Add `void GetPossibleIdeologies(CvPlayer* pPlayer, std::vector<PolicyBranchTypes>& out)`.
  - Return nothing if the player has an ideology, the current era is below `ERA_INDUSTRIAL`, or the player is a vassal whose master has an ideology.
  - Otherwise return every branch that passes `IsIdeologyChoiceValid`.

**1b. `CvPolicyAI::DoChooseIdeology`**
- Move the adoption tail into a private `AdoptIdeology(CvPlayer* pPlayer, PolicyBranchTypes eBranch)`. The tail is `SetPolicyBranchUnlocked`, `LogBranchChoice`, GEorGM, and the `PlayerAdoptPolicyBranch` hook. The scoring path calls this function at its end.
- Right after the vassal block:
  - Read `m_iNextIdeology`, then reset it to `-1`.
  - If `IsIdeologyChoiceValid` passes, call `AdoptIdeology` and return.

**1c. Lua bindings (`Lua/CvLuaPlayer.h` / `.cpp`)**
- Add `GetPossibleIdeologies()`, which returns a table of branch IDs.
- Add `SetNextIdeology(branchID)`, where `-1` clears the slot.
- Add `GetNextIdeology()`.
- Register all three next to `SetNextPolicy` and `GetNextPolicy`.

### 2. MCP server (`mcp-server/`)

**2a. `lua/get-player-options.lua`**
- Add `Ideologies = player:GetPossibleIdeologies()` and `NextIdeology = player:GetNextIdeology()`.

**2b. `src/knowledge/schema/timed.ts` and `setup.ts`**
- Add `Ideologies: JSONColumnType<string[]>` and `NextIdeology: string | null` to `PlayerOptions`. Add both columns to the table creation.
- Add a small `addMissingColumns(db, table, columns)` step that reads `PRAGMA table_info` and runs `ALTER TABLE ... ADD COLUMN` for missing columns. This lets resumed games with an existing database keep working.

**2c. `src/knowledge/getters/player-options.ts`**
- Map `Ideologies` with `convertToNames(..., "BranchType")`.
- Map `NextIdeology` with `convertToName(..., "BranchType")`.

**2d. `src/tools/knowledge/get-options.ts`**
- Append one entry per ideology to `Options.Policies`:
  - key: `"<Name> (New Ideology)"`
  - value: the branch help from `formatPolicyHelp`
- Add a top-level `Ideology: { Next: <name or "None"> }` when `Ideologies` is not empty or `NextIdeology` is set. Extend `outputSchema` to match.
- Leave `Policy.Next` and its rationale logic unchanged. Ideology picks never write `PolicyChanges`.

**2e. `src/tools/actions/set-policy.ts`**
- After resolving `branchID`, the Lua script checks whether the branch is in `GetPossibleIdeologies()`.
  - If so, it calls `SetNextIdeology(branchID)` and returns the previous ideology.
  - If not, the existing branch and policy path runs.
- `None` keeps its current meaning and clears only the normal slot. To change an ideology pick, the strategist picks another ideology.
- An ideology pick skips `storeMutableKnowledge('PolicyChanges', ...)` so the normal `Policy.Next` display stays accurate. It still calls `pushAction` with the summary "Ideology: <previous> → <new>" and the rationale.

### 3. Vox Agents (`vox-agents/`)

**3a. `src/strategist/agents/null-strategist.ts`**
- Leave keys ending in `(New Ideology)` out of the random pick. The baseline keeps using the game AI's ideology choice, so past experiments stay comparable.

**3b. `src/strategist/agents/simple-strategist-base.ts`**
- Add one bullet after the `set-policy` line. It should say that options marked "New Ideology" can be chosen ahead of time with `set-policy`, and that the choice is adopted automatically when ideologies unlock.

### 4. Human-control panel (`civ5-mod/UI/VoxDeorumHumanPanel.lua`)

- Treat `(New Ideology)` like `(New Branch)` for grouping and icon lookup. If the texture table lacks icons for the ideology branches, fall back to the default branch art.
- Mark the option matching `Ideology.Next` as the current selection.
- Submission is unchanged: the staged policy goes to `set-policy`, which routes ideologies on the server. One submission per turn covers either a policy or an ideology.

### 5. Documentation

- `mcp-server/docs/influence/forced-choices.md`:
  - Add an "Ideology pre-selection" subsection under `set-policy`. Cover the slot, the window, the order in which the rules win, and the fallback.
  - Change the "Ideology picks" bullet to say tenets.
- `docs/developers/mcp-server/influence.md`: extend the "Forced choices" sentence to mention ideology pre-selection.

## Risks and open questions

- **Old saves will not load.** Adding a serialized field breaks loading saves made with the older DLL, as `m_iNextPolicy` did. Controlled games cannot be resumed across this DLL update.
- **The strategist won't see its reasoning for the pick.** Ideology picks are not stored in `PolicyChanges`, so `get-options` shows the pending ideology but not why it was chosen. The reasoning still appears in the action log and in telemetry. A dedicated mutable-knowledge table would fix this, but it adds schema work. Open question: is this needed?
- **Team rules are overridden.** A pre-selection beats the team-leader heuristic, so a strategist can split a team's ideologies. We accept this because it is the strategist's call.
- **Experiment comparability.** LLM strategists will now choose ideologies, which shifts their results relative to earlier runs. The null baseline is unchanged (Step 3a).
- **The window can open early.** Players reach the Industrial era long before unlock under some settings. Showing ideologies early is harmless, but it adds a few hundred prompt tokens per turn. If that matters, narrow the window to "Industrial era and `IsTimeToChooseIdeology` within reach". There is no cheap predictor for that, so we start with the era rule.

## Verification

- Run `npm run build:all` and `npm run test:all` from the repository root.
- Add or extend Vitest coverage with controlled inputs:
  - `mcp-server/tests/mock/actions/set-policy.test.ts`: an ideology name calls `SetNextIdeology` and skips `PolicyChanges`. An ideology outside the window is rejected. A normal branch still uses `SetNextPolicy`.
  - `mcp-server/tests/mock/knowledge/getters/player-options.test.ts`: `Ideologies` and `NextIdeology` map to names.
  - A `get-options` test: ideology entries carry the `(New Ideology)` label, and the `Ideology.Next` block appears only while the choice is open.
  - A `setup.ts` test: opening a database created with the old `PlayerOptions` schema adds the two columns.
  - A null-strategist test: `(New Ideology)` keys are never picked.
- Build and deploy the DLL with `build-and-copy.bat`. In an Industrial-era save, use the Lua console or FireTuner:
  - `GetPossibleIdeologies()` lists the three ideologies.
  - After `SetNextIdeology(GameInfoTypes.POLICY_BRANCH_ORDER)`, ending turns until unlock adopts Order.
  - The bridge log shows `PlayerAdoptPolicyBranch` for the adoption.
- After a real game, check telemetry with read-only queries:
  - `get-options` shows `(New Ideology)` entries before unlock.
  - A `set-policy` call with an ideology precedes the adoption.
  - The adoption event appears in a met civilization's `get-events`.

## Out of scope

- Ideology switching, which stays with `DoConsiderIdeologySwitch`.
- Tenet selection, which already works through `set-policy`.
