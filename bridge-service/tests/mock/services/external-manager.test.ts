import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalManager } from '../../../src/services/external-manager.js';
import { dllConnector } from '../../../src/services/dll-connector.js';
import { respondSuccess } from '../../../src/types/api.js';
import { TEST_URLS } from '../../test-utils/constants.js';

describe('External Manager', () => {
  beforeEach(() => {
    vi.spyOn(dllConnector, 'sendNoWait').mockReturnValue(respondSuccess());
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    const functions = externalManager.getFunctions().result?.functions || [];
    for (const func of functions) {
      await externalManager.unregisterFunction(func.name);
    }
  });

  it('applies the default timeout when one is not provided', async () => {
    const response = await externalManager.registerFunction({
      name: 'defaultTimeoutFunction',
      url: TEST_URLS.MOCK_SERVICE,
      async: true
    });

    expect(response.success).toBe(true);
    const functions = externalManager.getFunctions().result?.functions || [];
    expect(functions).toEqual([
      expect.objectContaining({
        name: 'defaultTimeoutFunction',
        timeout: 5000
      })
    ]);
  });

  it('rejects invalid registrations without mutating state', async () => {
    const response = await externalManager.registerFunction({
      name: '123-invalid',
      url: TEST_URLS.MOCK_SERVICE,
      async: true
    });

    expect(response.success).toBe(false);
    expect(externalManager.getFunctions().result?.functions).toEqual([]);
  });
});
