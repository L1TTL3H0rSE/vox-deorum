/**
 * Tests for the post-notification action tool. The Lua boundary is stubbed (no
 * bridge); we assert argument shaping, the CounterpartID default, IPC text
 * sanitization, participant validation, and the Success/Result passthrough.
 *
 * Stage 7.04 widened the recipient to the full addressable player range so a human watching from
 * an observer slot can be notified. The delivery-side half of that (the pinned-observer redirect)
 * lives in `lua/post-notification.lua` and needs live game state, which this tier cannot execute
 * (the repo has no Lua harness), so it is not exercised here.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { LuaFunction } from '../../../src/bridge/lua-function.js';
import createPostNotificationTool from '../../../src/tools/actions/post-notification.js';
import { MaxMajorCivs, MaxPlayers } from '../../../src/knowledge/schema/base.js';

const tool = createPostNotificationTool();

afterEach(() => {
  vi.restoreAllMocks();
});

/** Stub the Lua boundary so super.call() returns a canned boolean result. */
function mockLua(result = true, success = true) {
  return vi.spyOn(LuaFunction.prototype, 'execute').mockResolvedValue({ success, result } as any);
}

describe('post-notification', () => {
  it('forwards a diplomacy notification with the counterpart and maps Success/Result', async () => {
    const spy = mockLua(true);

    const result = await tool.execute({
      PlayerID: 0, CounterpartID: 3, Summary: 'Napoleon writes', Message: 'We should talk.',
    } as any);

    expect(result.Success).toBe(true);
    expect(result.Result).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      0,
      3,
      '[COLOR_POSITIVE_TEXT]Napoleon writes[ENDCOLOR]',
      'We should talk.',
    );
  });

  it('defaults CounterpartID to -1 when omitted (general message path)', async () => {
    const spy = mockLua(true);

    await tool.execute({
      PlayerID: 2, Summary: 'Notice', Message: 'The council has news.',
    } as any);

    expect(spy).toHaveBeenCalledWith(
      2,
      -1,
      '[COLOR_POSITIVE_TEXT]Notice[ENDCOLOR]',
      'The council has news.',
    );
  });

  it('trims text and strips the IPC frame delimiter from Summary and Message', async () => {
    const spy = mockLua(true);

    await tool.execute({
      PlayerID: 1,
      Summary: '  head!@#$%^!line  ',
      Message: '  before!@#$%^!after  ',
    } as any);

    expect(spy).toHaveBeenCalledWith(
      1,
      -1,
      '[COLOR_POSITIVE_TEXT]headline[ENDCOLOR]',
      'beforeafter',
    );
  });

  it('truncates messages longer than 400 characters and ends them with an ellipsis', async () => {
    const spy = mockLua(true);

    await tool.execute({
      PlayerID: 1,
      Summary: 'Notice',
      Message: 'M'.repeat(401),
    } as any);

    const message = spy.mock.calls[0]?.[3] as string;
    expect(message).toHaveLength(400);
    expect(message).toBe(`${'M'.repeat(397)}...`);
  });

  it('does not truncate a message of exactly 400 characters', async () => {
    const spy = mockLua(true);
    const message = 'M'.repeat(400);

    await tool.execute({
      PlayerID: 1,
      Summary: 'Notice',
      Message: message,
    } as any);

    expect(spy.mock.calls[0]?.[3]).toBe(message);
  });

  it('rejects a diplomacy notification addressed to the receiving player', async () => {
    const spy = mockLua(true);

    await expect(tool.execute({
      PlayerID: 1, CounterpartID: 1, Summary: 'Notice', Message: 'Message',
    } as any)).rejects.toThrow('CounterpartID must be different from PlayerID');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['Summary', '!@#$%^!', 'Message'],
    ['Message', 'Summary', '  \t\n  '],
  ])('rejects %s when sanitization leaves no visible text', async (field, summary, message) => {
    const spy = mockLua(true);

    await expect(tool.execute({
      PlayerID: 1, Summary: summary, Message: message,
    } as any)).rejects.toThrow(`${field} must contain visible text after IPC sanitization`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('propagates a failed Lua response', async () => {
    mockLua(false, false);

    const result = await tool.execute({
      PlayerID: 0, Summary: 's', Message: 'm',
    } as any);

    expect(result.Success).toBe(false);
  });

  it('preserves a Civ V rejection as a false result on a successful bridge call', async () => {
    mockLua(false, true);

    const result = await tool.execute({
      PlayerID: 0, Summary: 's', Message: 'm',
    } as any);

    expect(result.Success).toBe(true);
    expect(result.Result).toBe(false);
  });
});

describe('post-notification observer-capable recipient', () => {
  it('accepts an observer-slot PlayerID beyond the major-civ range', async () => {
    const spy = mockLua(true);

    // A pure observer's real slot sits above MaxMajorCivs; it is still a real Players[] entry and
    // a legitimate notification recipient, so the schema must admit it.
    const observerSlot = MaxMajorCivs + 5;
    expect(() => tool.inputSchema.parse({
      PlayerID: observerSlot, Summary: 's', Message: 'm',
    })).not.toThrow();

    await tool.execute({ PlayerID: observerSlot, Summary: 'Notice', Message: 'A reply arrived.' } as any);
    expect(spy).toHaveBeenCalledWith(
      observerSlot,
      -1,
      '[COLOR_POSITIVE_TEXT]Notice[ENDCOLOR]',
      'A reply arrived.',
    );
  });

  it('bounds PlayerID at the full player range and CounterpartID at the major civs', async () => {
    // The counterpart is a conversation partner, so it stays a major civilization even though the
    // recipient no longer has to be one.
    expect(() => tool.inputSchema.parse({ PlayerID: MaxPlayers - 1, Summary: 's', Message: 'm' })).not.toThrow();
    expect(() => tool.inputSchema.parse({ PlayerID: MaxPlayers, Summary: 's', Message: 'm' })).toThrow();
    expect(() => tool.inputSchema.parse({ PlayerID: -1, Summary: 's', Message: 'm' })).toThrow();
    expect(() => tool.inputSchema.parse({
      PlayerID: 0, CounterpartID: MaxMajorCivs, Summary: 's', Message: 'm',
    })).toThrow();
  });
});
