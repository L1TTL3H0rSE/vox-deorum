/**
 * Tests for the ActionTool abstract base (src/tools/abstract/action.ts).
 *
 * Covers the contracts the base class owns directly: the exported sourceTurnField
 * default and resolveSourceTurn's arg-vs-manager-turn rule. The pushAction delegation
 * and the shared annotations + metadata are exercised end-to-end by every concrete
 * action suite; schema validation is intentionally out of scope.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as z from 'zod';
import { ActionTool, sourceTurnField } from '../../../../src/tools/abstract/action.js';
import { knowledgeManager } from '../../../../src/server.js';

/**
 * Minimal concrete ActionTool that supplies every abstract member and exposes the
 * protected resolveSourceTurn helper as a public wrapper so it can be exercised directly.
 */
class TestActionTool extends ActionTool {
  readonly name = 'test-action';
  readonly description = 'test action tool';
  readonly inputSchema = z.object({ PlayerID: z.number() }).extend(sourceTurnField);
  protected readonly resultSchema = z.any();
  protected readonly arguments = ['playerID'];
  protected readonly script = 'return {}';

  async execute() {
    return { Success: true };
  }

  // Public wrapper over the protected member under test.
  public callResolveSourceTurn(args: { Turn?: number }) {
    return this.resolveSourceTurn(args);
  }
}

let tool: TestActionTool;

beforeEach(() => {
  tool = new TestActionTool();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sourceTurnField', () => {
  it('exposes a Turn zod field defaulting to -1', () => {
    const parsed = z.object({}).extend(sourceTurnField).parse({});
    expect(parsed).toEqual({ Turn: -1 });
  });
});

describe('resolveSourceTurn', () => {
  beforeEach(() => {
    vi.spyOn(knowledgeManager, 'getTurn').mockReturnValue(42);
  });

  it('uses the manager turn when Turn is the -1 sentinel', () => {
    expect(tool.callResolveSourceTurn({ Turn: -1 })).toBe(42);
  });

  it('uses the manager turn when Turn is undefined', () => {
    expect(tool.callResolveSourceTurn({})).toBe(42);
  });

  it('uses the arg when Turn >= 0', () => {
    expect(tool.callResolveSourceTurn({ Turn: 0 })).toBe(0);
    expect(tool.callResolveSourceTurn({ Turn: 3 })).toBe(3);
  });
});
