/**
 * @module utils/tools/bash-tool
 *
 * The `bash` tool: runs a script in the calling player's workspace (see
 * utils/workspace/player-workspace.ts). Registered only on contexts whose seat turns files on.
 */

import { z } from 'zod';
import type { AgentParameters } from '../../infra/vox-agent.js';
import type { VoxContext } from '../../infra/vox-context.js';
import type { ResolvedFilesConfig } from '../../types/config.js';
import { workspaceCwd, workspaceScratchPath, type WorkspaceExecResult } from '../workspace/player-workspace.js';
import { createSimpleTool } from './simple-tools.js';

/** The registered name of the workspace tool. */
export const bashToolName = 'bash';

/**
 * Count the model steps that called bash, including invalid calls. A step with several bash
 * calls counts once, because the quota limits model steps rather than commands.
 *
 * @param steps - The steps of one agent execution
 */
export function bashStepsUsed(steps: Array<{ toolCalls: Array<{ toolName: string }> }>): number {
  return steps.filter((step) => step.toolCalls.some((call) => call.toolName === bashToolName)).length;
}

/** One line per mount, naming its virtual path and access, for the tool description. */
function describeMounts(files: ResolvedFilesConfig): string[] {
  const lines: string[] = [];
  if (files.game) lines.push(`- ${workspaceCwd}/game (${files.game}): notes for your civilization in this game`);
  for (const [name, access] of Object.entries(files.shared)) {
    lines.push(`- ${workspaceCwd}/shared/${name} (${access}): shared across games and seats`);
  }
  lines.push(`- ${workspaceScratchPath} (write): your scratch space, kept until the game ends`);
  return lines;
}

/** A failed command result carrying only an error message. */
function failure(message: string): WorkspaceExecResult {
  return { stdout: '', stderr: message, exitCode: 1 };
}

/**
 * Create the bash tool for a context. The description is fixed by the context's files setting,
 * so it stays the same for every call. Each call runs in the workspace of the player and game in
 * the active parameters and stops with the active run. Once the execution has used its quota of
 * bash steps, calls return a failure without running (see VoxContext.bashOpen).
 *
 * @param context - A context whose `files` setting is on
 */
export function createBashTool<TParameters extends AgentParameters>(context: VoxContext<TParameters>) {
  const files = context.files;
  if (!files) throw new Error('The bash tool needs a context with files turned on.');

  return createSimpleTool<TParameters, { Command: string }, WorkspaceExecResult>({
    name: bashToolName,
    description: [
      `Run a bash script in a simulated shell with file access. Each call starts in ${workspaceCwd} with a fresh shell state. Mounted folders:`,
      ...describeMounts(files),
      'Files written anywhere else disappear after the call. There is no network, Python, or JavaScript.',
      'Available commands include ls, cat, head, tail, grep, rg, sed, awk, find, sort, jq, sqlite3, and tee. Write files with heredocs.',
      `You may use bash in up to ${files.quota} responses per task. Commands are cheap but each response is costly, and all bash calls in one response count once, so issue independent commands as parallel calls in the same response or combine them in one script.`,
      'Returns stdout, stderr, and exitCode; long output is truncated.',
    ].join('\n'),
    inputSchema: z.object({
      Command: z.string().describe('The bash script to run. Combine related reads and writes into one script.'),
    }),
    execute: async (input, parameters) => {
      if (!context.bashOpen) {
        return failure(`The workspace is closed: this task used all ${files.quota} of its bash responses. Finish with the other tools.`);
      }
      let workspace;
      try {
        workspace = context.workspace(parameters.gameID, parameters.playerID);
      } catch (error) {
        return failure(`Could not open the workspace: ${(error as Error).message}`);
      }
      if (!workspace) return failure('No workspace is available for this player.');
      return workspace.exec(input.Command, context.currentSignal());
    },
  }, context);
}
