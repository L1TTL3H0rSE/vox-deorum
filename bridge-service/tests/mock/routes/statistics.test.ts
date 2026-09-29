/**
 * Connection statistics test - Tests for connection monitoring and statistics tracking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DLLConnector } from '../../../src/services/dll-connector.js';
import { logSuccess } from '../../test-utils/helpers.js';
import { restoreSharedMockDLL, startIsolatedMockDLL } from '../../test-utils/isolated-mock.js';
import { MockDLLServer } from '../../test-utils/mock-dll-server.js';

// Connection statistics and monitoring
describe('Connection Statistics and Monitoring', () => {
  let connector: DLLConnector;
  let mockDLL: MockDLLServer;
  let originalPipeId: string;
  
  beforeEach(async () => {
    const isolated = await startIsolatedMockDLL('statistics-connector');
    mockDLL = isolated.mockDLL;
    originalPipeId = isolated.originalPipeId;
    connector = new DLLConnector();
  });
  
  afterEach(async () => {
    if (connector && connector.isConnected()) {
      await connector.disconnect();
    }
    await restoreSharedMockDLL(mockDLL, originalPipeId);
  });

  // Accurate connection statistics tracking
  it('should provide accurate connection statistics', async () => {
    // Test initial stats
    let stats = connector.getStats();
    expect(stats.connected).toBe(false);
    expect(stats.pendingRequests).toBe(0);
    expect(stats.reconnectAttempts).toBe(0);
    
    // Test stats after connection
    await expect(connector.connect()).resolves.toBe(true);
    stats = connector.getStats();
    expect(stats.connected).toBe(true);
    expect(stats.pendingRequests).toBe(0);
    expect(stats.reconnectAttempts).toBe(0);
    
    // Test stats after disconnect
    await connector.disconnect();
    stats = connector.getStats();
    expect(stats.connected).toBe(false);
    expect(stats.pendingRequests).toBe(0);
    
    logSuccess('Connection statistics working correctly');
  });
});
