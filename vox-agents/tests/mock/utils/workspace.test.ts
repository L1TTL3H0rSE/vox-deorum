/** Tests for player workspaces backed by just-bash (src/utils/workspace/player-workspace.ts). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedFilesConfig } from '../../../src/types/config.js';

const mocks = vi.hoisted(() => ({
  config: { telemetryDir: '' },
}));

vi.mock('../../../src/utils/config.js', () => ({ config: mocks.config }));

import {
  PlayerWorkspace,
  workspaceGuideFile,
  workspaceNodeSupported,
  workspaceOutputLimit,
  workspaceRoot,
} from '../../../src/utils/workspace/player-workspace.js';

/** A resolved files setting with defaults for the fields a test leaves out. */
function files(overrides: Partial<ResolvedFilesConfig> = {}): ResolvedFilesConfig {
  return { game: 'write', shared: {}, quota: 20, ...overrides };
}

/** The real game folder for one player. */
function gameFolder(gameID: string, playerID: number): string {
  return path.join(workspaceRoot(), 'games', `${gameID}-player-${playerID}`);
}

describe('workspaceNodeSupported', () => {
  it('should reject Node 22 releases before 22.17.0 and accept later ones', () => {
    expect(workspaceNodeSupported('22.12.0')).toBe(false);
    expect(workspaceNodeSupported('22.16.9')).toBe(false);
    expect(workspaceNodeSupported('20.19.0')).toBe(false);
    expect(workspaceNodeSupported('22.17.0')).toBe(true);
    expect(workspaceNodeSupported('22.23.3')).toBe(true);
    expect(workspaceNodeSupported('24.1.0')).toBe(true);
  });
});

describe('PlayerWorkspace', () => {
  let telemetryDir: string;

  beforeEach(() => {
    telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-workspace-'));
    mocks.config.telemetryDir = telemetryDir;
  });

  afterEach(() => {
    fs.rmSync(telemetryDir, { recursive: true, force: true });
  });

  it('should list mounts without creating folders before the first command', () => {
    const workspace = new PlayerWorkspace(files({ shared: { lessons: 'read' } }), 'g1', 0);
    expect(workspace.mounts.map((mount) => [mount.virtualPath, mount.access])).toEqual([
      ['/tmp', 'write'],
      ['/workspace/game', 'write'],
      ['/workspace/shared/lessons', 'read'],
    ]);
    expect(fs.existsSync(workspaceRoot())).toBe(false);
  });

  it('should reject a game ID that would leave the games folder', () => {
    expect(() => new PlayerWorkspace(files(), '../escape', 0)).toThrow();
  });

  describe.skipIf(!workspaceNodeSupported())('on disk', () => {
    it('should write game files to the player folder and share them with a later workspace', async () => {
      const first = new PlayerWorkspace(files(), 'g1', 0);
      const write = await first.exec("cat > game/notes.md <<'EOF'\n- plan\n  - detail\nEOF");
      expect(write.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(gameFolder('g1', 0), 'notes.md'), 'utf8')).toBe('- plan\n  - detail\n');

      const second = new PlayerWorkspace(files(), 'g1', 0);
      expect((await second.exec('cat game/notes.md')).stdout).toBe('- plan\n  - detail\n');
    });

    it('should keep players apart', async () => {
      await new PlayerWorkspace(files(), 'g1', 0).exec('echo mine > game/secret.md');
      const other = await new PlayerWorkspace(files(), 'g1', 1).exec('cat game/secret.md');
      expect(other.exitCode).not.toBe(0);
      expect(other.stdout).toBe('');
    });

    it('should refuse writes to a read mount without changing disk', async () => {
      const sharedDir = path.join(workspaceRoot(), 'shared', 'reference');
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(path.join(sharedDir, 'doc.md'), 'reference\n');

      const workspace = new PlayerWorkspace(files({ game: false, shared: { reference: 'read' } }), 'g1', 0);
      expect((await workspace.exec('cat shared/reference/doc.md')).stdout).toBe('reference\n');
      const write = await workspace.exec('echo x > shared/reference/new.md');
      expect(write.exitCode).not.toBe(0);
      expect(write.stderr).not.toBe('');
      expect(fs.readdirSync(sharedDir)).toEqual(['doc.md']);
    });

    it('should show one shared folder to two games', async () => {
      const setting = files({ shared: { lessons: 'write' } });
      await new PlayerWorkspace(setting, 'g1', 0).exec('echo lesson > shared/lessons/one.md');
      expect((await new PlayerWorkspace(setting, 'g2', 3).exec('cat shared/lessons/one.md')).stdout).toBe('lesson\n');
    });

    it('should keep escape attempts off the real disk', async () => {
      const outside = path.join(telemetryDir, 'outside.txt');
      fs.writeFileSync(outside, 'outside\n');
      const workspace = new PlayerWorkspace(files(), 'g1', 0);

      const hostPath = outside.split(path.sep).join('/');
      const read = await workspace.exec(`cat game/../../../outside.txt; cat '${outside}'; cat '${hostPath}'; cat /${hostPath}`);
      expect(read.stdout).not.toContain('outside');

      await workspace.exec('echo pwn > game/../../escape.txt; echo pwn > ../escape2.txt; echo pwn > /tmp/../../escape3.txt');
      const created = fs.readdirSync(telemetryDir, { recursive: true }).map(String);
      expect(created.filter((entry) => entry.includes('escape'))).toEqual([]);
    });

    it('should keep scratch files for one player through the game and nothing else between calls', async () => {
      const first = new PlayerWorkspace(files(), 'g1', 0);
      await first.exec('echo draft > /tmp/draft.md; echo lost > /home/lost.md');
      const later = await first.exec('cat /tmp/draft.md; cat /home/lost.md');
      expect(later.stdout).toBe('draft\n');
      expect(later.exitCode).not.toBe(0);

      expect((await new PlayerWorkspace(files(), 'g1', 0).exec('cat /tmp/draft.md')).stdout).toBe('draft\n');
      expect((await new PlayerWorkspace(files(), 'g1', 1).exec('cat /tmp/draft.md')).stdout).toBe('');
      expect((await new PlayerWorkspace(files(), 'g2', 0).exec('cat /tmp/draft.md')).stdout).toBe('');
    });

    it('should give a seat without a game folder its scratch folder', async () => {
      const workspace = new PlayerWorkspace(files({ game: false, shared: { lessons: 'read' } }), 'g1', 0);
      expect((await workspace.exec('echo kept > /tmp/a.md && cat /tmp/a.md')).stdout).toBe('kept\n');
    });

    it('should seed guides once at writable roots and never overwrite them', async () => {
      const setting = files({ shared: { lessons: 'write', reference: 'read' } });
      await new PlayerWorkspace(setting, 'g1', 0).exec('true');

      const gameGuide = path.join(gameFolder('g1', 0), workspaceGuideFile);
      const sharedGuide = path.join(workspaceRoot(), 'shared', 'lessons', workspaceGuideFile);
      expect(fs.existsSync(gameGuide)).toBe(true);
      expect(fs.existsSync(sharedGuide)).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot(), 'shared', 'reference', workspaceGuideFile))).toBe(false);

      fs.writeFileSync(gameGuide, 'edited by an agent\n');
      await new PlayerWorkspace(setting, 'g1', 0).exec('true');
      expect(fs.readFileSync(gameGuide, 'utf8')).toBe('edited by an agent\n');
    });

    it('should truncate long output', async () => {
      const lines = Array.from({ length: workspaceOutputLimit }, (_, index) => `${index + 1}\n`).join('');
      const result = await new PlayerWorkspace(files(), 'g1', 0).exec(`seq 1 ${workspaceOutputLimit}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.startsWith(lines.slice(0, workspaceOutputLimit))).toBe(true);
      expect(result.stdout.length).toBeLessThan(lines.length);
    });
  });
});
