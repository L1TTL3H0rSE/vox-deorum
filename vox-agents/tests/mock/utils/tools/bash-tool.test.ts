/** Tests for the workspace bash tool and its registration on VoxContext (src/utils/tools/bash-tool.ts). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoxContext } from '../../../../src/infra/vox-context.js';
import type { AgentParameters } from '../../../../src/infra/vox-agent.js';
import { config } from '../../../../src/utils/config.js';
import { bashStepsUsed, bashToolName } from '../../../../src/utils/tools/bash-tool.js';
import { PlayerWorkspace, workspaceNodeSupported, workspaceRoot } from '../../../../src/utils/workspace/player-workspace.js';

const files = { game: 'write' as const, shared: {}, quota: 20 };

describe('bash tool', () => {
  let telemetryDir: string;
  let savedTelemetryDir: string;

  beforeEach(() => {
    savedTelemetryDir = config.telemetryDir;
    telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-bash-tool-'));
    config.telemetryDir = telemetryDir;
  });

  afterEach(() => {
    config.telemetryDir = savedTelemetryDir;
    fs.rmSync(telemetryDir, { recursive: true, force: true });
  });

  it('should be registered only on contexts with files on', () => {
    const plain = new VoxContext<AgentParameters>({}, 'bash-off');
    plain.registerAgentTools();
    expect(plain.tools[bashToolName]).toBeUndefined();
    expect(plain.workspace('g1', 0)).toBeUndefined();

    const seat = new VoxContext<AgentParameters>({}, 'bash-on');
    seat.files = files;
    seat.registerAgentTools();
    expect(seat.tools[bashToolName]).toBeDefined();
  });

  it('should share one workspace per player across calls', () => {
    const seat = new VoxContext<AgentParameters>({}, 'bash-share');
    seat.files = files;
    expect(seat.workspace('g1', 0)).toBe(seat.workspace('g1', 0));
    expect(seat.workspace('g1', 1)).not.toBe(seat.workspace('g1', 0));
  });

  it('should return a failure result for a game ID that cannot name a folder', async () => {
    const seat = new VoxContext<AgentParameters>({}, 'bash-bad-game');
    seat.files = files;
    seat.registerAgentTools();
    const tool = seat.tools[bashToolName] as any;

    const result = await seat.withRun({ parameters: { playerID: 2, gameID: '../g7', turn: 1 } }, () =>
      tool.execute({ Command: 'echo hi' }, { toolCallId: 'c1', messages: [] }),
    );
    expect(result).toMatchObject({ stdout: '', exitCode: 1 });
  });

  it('should refuse to run once the execution has no bash steps left', async () => {
    const seat = new VoxContext<AgentParameters>({}, 'bash-closed');
    seat.files = files;
    seat.registerAgentTools();
    const tool = seat.tools[bashToolName] as any;
    const exec = vi.spyOn(PlayerWorkspace.prototype, 'exec');

    const result = await seat.withRun({ parameters: { playerID: 2, gameID: 'g7', turn: 1 } }, () => {
      seat.bashOpen = false;
      return tool.execute({ Command: 'echo hi' }, { toolCallId: 'c1', messages: [] });
    });
    expect(result).toMatchObject({ stdout: '', exitCode: 1 });
    expect(exec).not.toHaveBeenCalled();
    exec.mockRestore();
  });

  it('should count each step that called bash once', () => {
    const step = (...names: string[]) => ({ toolCalls: names.map((toolName) => ({ toolName })) });
    expect(bashStepsUsed([step(), step('bash', 'bash', 'bash'), step('other'), step('other', 'bash')])).toBe(2);
  });

  it.skipIf(!workspaceNodeSupported())('should run commands in the workspace of the run parameters', async () => {
    const seat = new VoxContext<AgentParameters>({}, 'bash-run');
    seat.files = files;
    seat.registerAgentTools();
    const tool = seat.tools[bashToolName] as any;

    const result = await seat.withRun({ parameters: { playerID: 2, gameID: 'g7', turn: 1 } }, () =>
      tool.execute({ Command: 'echo noted > game/a.md && cat game/a.md' }, { toolCallId: 'c1', messages: [] }),
    );
    expect(result).toMatchObject({ stdout: 'noted\n', exitCode: 0 });
    expect(fs.readFileSync(path.join(workspaceRoot(), 'games', 'g7-player-2', 'a.md'), 'utf8')).toBe('noted\n');
  });
});
