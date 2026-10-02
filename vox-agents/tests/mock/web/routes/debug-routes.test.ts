/**
 * @module tests/mock/web/debug-routes
 *
 * Supertest coverage for the Debug page routes. Temp folders stand in for the four log
 * sources, Civ 5's config.ini, and its MODS folder, so no real install is touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs, { type FileHandle } from 'fs/promises';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { Readable } from 'stream';

import { createDebugRoutes, maxLogTailBytes, type DebugPaths } from '../../../../src/web/routes/debug.js';
import { createLogBundle, pickLatestLogs } from '../../../../src/utils/debug/log-bundle.js';

let root: string;
let paths: DebugPaths;

/** Build an app whose debug routes read from the temp folders. */
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/debug', createDebugRoutes(async () => paths));
  return app;
}

/** Collect a binary response body into a Buffer. */
function binaryParser(res: NodeJS.ReadableStream, callback: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

/** Read every entry of a zip through its central directory. Supports stored and deflated entries. */
function unzip(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'));

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-debug-'));
  paths = {
    dirs: {
      agents: path.join(root, 'vox-agents', 'logs'),
      bridge: path.join(root, 'bridge-service', 'logs'),
      mcp: path.join(root, 'mcp-server', 'logs'),
      civ5: path.join(root, 'civ5', 'Logs')
    },
    civConfigPath: path.join(root, 'civ5', 'config.ini'),
    civModsDir: path.join(root, 'civ5', 'MODS')
  };
  await fs.mkdir(paths.dirs.agents, { recursive: true });
  await fs.mkdir(paths.dirs.civ5, { recursive: true });
  await fs.mkdir(path.join(paths.civModsDir, 'Vox Deorum (v1)'), { recursive: true });
  await fs.writeFile(path.join(paths.dirs.agents, 'combined.log'), '{"level":"info","message":"hello"}\n');
  await fs.writeFile(path.join(paths.dirs.agents, 'notes.txt'), 'not a log');
  await fs.writeFile(path.join(paths.dirs.civ5, 'Lua.log'), '[1.0] Vox Deorum: loaded\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('debug routes', () => {
  describe('GET /api/debug/status', () => {
    it('lists .log files per source and gives empty lists for missing folders', async () => {
      const res = await request(makeApp()).get('/api/debug/status');

      expect(res.status).toBe(200);
      expect(res.body.civLogging).toBe(false);
      expect(res.body.sources.agents.map((file: { name: string }) => file.name)).toEqual(['combined.log']);
      expect(res.body.sources.civ5.map((file: { name: string }) => file.name)).toEqual(['Lua.log']);
      expect(res.body.sources.bridge).toEqual([]);
      expect(res.body.sources.mcp).toEqual([]);
    });
  });

  describe('PUT /api/debug/civ-logging', () => {
    it('writes LoggingEnabled on and off, creating config.ini when missing', async () => {
      const app = makeApp();

      const on = await request(app).put('/api/debug/civ-logging').send({ enabled: true });
      expect(on.status).toBe(200);
      expect(on.body).toEqual({ civLogging: true });
      expect((await request(app).get('/api/debug/status')).body.civLogging).toBe(true);

      const off = await request(app).put('/api/debug/civ-logging').send({ enabled: false });
      expect(off.body).toEqual({ civLogging: false });
      expect((await request(app).get('/api/debug/status')).body.civLogging).toBe(false);
    });

    it('keeps unrelated config.ini settings', async () => {
      await fs.writeFile(paths.civConfigPath, '[CONFIG]\nSyncRandSeed = 7\n[DEBUG]\nLoggingEnabled = 0\n');

      await request(makeApp()).put('/api/debug/civ-logging').send({ enabled: true });

      const content = await fs.readFile(paths.civConfigPath, 'utf-8');
      expect(content).toContain('SyncRandSeed = 7');
      expect(content).toMatch(/LoggingEnabled\s*=\s*1/);
    });

    it('leaves config.ini untouched when it exists but cannot be read', async () => {
      const original = '[CONFIG]\nSyncRandSeed = 7\n[DEBUG]\nLoggingEnabled = 0\n';
      await fs.writeFile(paths.civConfigPath, original);
      vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }));

      const res = await request(makeApp()).put('/api/debug/civ-logging').send({ enabled: true });

      expect(res.status).toBe(500);
      expect(await fs.readFile(paths.civConfigPath, 'utf-8')).toBe(original);
    });

    it('rejects a non-boolean value', async () => {
      const res = await request(makeApp()).put('/api/debug/civ-logging').send({ enabled: 'yes' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/debug/logs/:source/:file', () => {
    it('returns a listed file in full', async () => {
      const res = await request(makeApp()).get('/api/debug/logs/civ5/Lua.log');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ source: 'civ5', name: 'Lua.log', truncated: false });
      expect(res.body.content).toContain('loaded');
    });

    it('returns 404 for unknown sources, unlisted files, and paths outside the folder', async () => {
      const app = makeApp();
      expect((await request(app).get('/api/debug/logs/secrets/combined.log')).status).toBe(404);
      expect((await request(app).get('/api/debug/logs/agents/notes.txt')).status).toBe(404);
      expect((await request(app).get(`/api/debug/logs/agents/${encodeURIComponent('../../civ5/config.ini')}`)).status).toBe(404);
    });

    it('returns only the tail of a large file, starting at a whole line', async () => {
      const line = `${'x'.repeat(99)}\n`;
      const lineCount = Math.ceil(maxLogTailBytes / line.length) + 50;
      await fs.writeFile(path.join(paths.dirs.agents, 'combined.log'), line.repeat(lineCount) + 'last line\n');

      const res = await request(makeApp()).get('/api/debug/logs/agents/combined.log');

      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(true);
      expect(res.body.content.length).toBeLessThanOrEqual(maxLogTailBytes);
      expect(res.body.content.startsWith('x'.repeat(99))).toBe(true);
      expect(res.body.content.endsWith('last line\n')).toBe(true);
    });
  });

  describe('GET /api/debug/bundle', () => {
    it('streams a zip with each source folder and a setup summary', async () => {
      const res = await request(makeApp()).get('/api/debug/bundle').buffer(true).parse(binaryParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="vox-deorum-logs-.*\.zip"/);

      const entries = unzip(res.body as Buffer);
      expect([...entries.keys()].sort()).toEqual(['civ5/Lua.log', 'setup.txt', 'vox-agents/combined.log']);
      expect(entries.get('civ5/Lua.log')).toContain('loaded');
      expect(entries.get('setup.txt')).toContain('Vox Deorum (v1)');
    });

    it('keeps only the newest file of each rotated service log', () => {
      const file = (name: string, minute: number) =>
        ({ name, size: 10, modified: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() });
      const files = [
        file('combined.log', 1),
        file('combined12.log', 3),
        file('error.log', 0),
        file('error1.log', 2),
        file('combined11.log', 2)
      ];

      const { kept, left } = pickLatestLogs(files);

      expect(kept.map(entry => entry.name)).toEqual(['combined12.log', 'error1.log']);
      expect(left.map(entry => entry.name).sort()).toEqual(['combined.log', 'combined11.log', 'error.log']);
    });

    it('bundles only the newest service logs but every Civ 5 log', async () => {
      const old = new Date(Date.UTC(2026, 0, 1));
      await fs.writeFile(path.join(paths.dirs.agents, 'combined1.log'), 'newer\n');
      await fs.utimes(path.join(paths.dirs.agents, 'combined.log'), old, old);
      await fs.writeFile(path.join(paths.dirs.civ5, 'xml.log'), 'xml\n');
      await fs.utimes(path.join(paths.dirs.civ5, 'xml.log'), old, old);

      const res = await request(makeApp()).get('/api/debug/bundle').buffer(true).parse(binaryParser);

      const names = [...unzip(res.body as Buffer).keys()].sort();
      expect(names).toEqual(['civ5/Lua.log', 'civ5/xml.log', 'setup.txt', 'vox-agents/combined1.log']);
    });

    it('takes only the newest bytes of an oversized file', async () => {
      await fs.writeFile(path.join(paths.dirs.civ5, 'Lua.log'), 'old line\nnew line\n');

      const bundle = await createLogBundle({ dirs: paths.dirs, modsDir: paths.civModsDir, civLogging: true, version: 'test', tailBytes: 9 });
      const chunks: Buffer[] = [];
      for await (const chunk of bundle.stream) chunks.push(chunk as Buffer);

      expect(unzip(Buffer.concat(chunks)).get('civ5/Lua.log')).toBe('new line\n');
    });

    it('fails the zip stream and closes every file when a read breaks mid-download', async () => {
      const realOpen = fs.open;
      const opened: Readable[] = [];
      vi.spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
        if (String(file).endsWith('combined.log')) {
          const broken = new Readable({ read() { this.destroy(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })); } });
          opened.push(broken);
          return { createReadStream: () => broken } as unknown as FileHandle;
        }
        const handle = await realOpen(file, ...rest);
        const createReadStream = handle.createReadStream.bind(handle);
        handle.createReadStream = (options) => {
          const stream = createReadStream(options);
          opened.push(stream);
          return stream;
        };
        return handle;
      });

      const bundle = await createLogBundle({ dirs: paths.dirs, modsDir: paths.civModsDir, civLogging: true, version: 'test' });
      const drain = async () => {
        for await (const _chunk of bundle.stream) { /* discard */ }
      };

      await expect(drain()).rejects.toThrow('EIO');
      expect(opened).toHaveLength(2);
      expect(opened.every(stream => stream.destroyed)).toBe(true);
    });

    it('skips a file it cannot open and notes it in the summary', async () => {
      const realOpen = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
        if (String(file).endsWith('Lua.log')) throw new Error('EBUSY: resource busy or locked');
        return realOpen(file, ...rest);
      });

      const res = await request(makeApp()).get('/api/debug/bundle').buffer(true).parse(binaryParser);

      expect(res.status).toBe(200);
      const entries = unzip(res.body as Buffer);
      expect(entries.has('civ5/Lua.log')).toBe(false);
      expect(entries.has('vox-agents/combined.log')).toBe(true);
      expect(entries.get('setup.txt')).toContain('civ5/Lua.log');
    });
  });
});
