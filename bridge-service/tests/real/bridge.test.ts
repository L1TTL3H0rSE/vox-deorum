import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../src/index.js';
import config from '../../src/utils/config.js';
import { dllConnector } from '../../src/services/dll-connector.js';
import { TestServer, expectSuccessResponse } from '../test-utils/helpers.js';
import { MockExternalService } from '../test-utils/mock-external-service.js';
import { TEST_PORTS, TEST_URLS } from '../test-utils/constants.js';
import { registerExternalFunction, triggerExternalCall } from '../test-utils/external-helpers.js';

describe('Real Bridge Smoke', () => {
  const testServer = new TestServer();
  const mockExternalService = new MockExternalService(TEST_PORTS.MOCK_EXTERNAL_SERVICE);

  beforeAll(async () => {
    await mockExternalService.start();
    await testServer.start(app, config.rest.port, config.rest.host);
  });

  afterAll(async () => {
    await testServer.stop();
    await mockExternalService.stop();
  });

  it('connects to the live Civ DLL', () => {
    expect(dllConnector.isConnected()).toBe(true);
  });

  it('executes a deterministic Lua script through the live bridge', async () => {
    const response = await request(app)
      .post('/lua/execute')
      .send({ script: 'return 42' })
      .expect(200);

    expect(response.body.success).toBe(true);
  });

  it('registers and calls an external function through the live bridge', async () => {
    await registerExternalFunction(app, {
      name: 'realSmokeExternal',
      url: TEST_URLS.MOCK_SERVICE,
      async: false,
      timeout: 5000
    });

    const response = await triggerExternalCall(app, 'realSmokeExternal', 'smoke-payload', false);
    expect(response).toEqual(
      expect.objectContaining({
        success: true,
        result: 'smoke-payload'
      })
    );
  });

  it('reports a syntax error in a Lua script', async () => {
    const response = await request(app)
      .post('/lua/execute')
      .send({ script: 'local x = ; return x' })
      .expect(500);

    expect(response.body.success).toBe(false);
  });

    it('should correctly serialize object and array return values from raw Lua script', async () => {
      // Test object return value
      const objectScript = `
        local player = {
          id = 1,
          name = "TestPlayer",
          score = 100,
          active = true
        }
        return player
      `;
      
      const objectResponse = await request(app)
        .post('/lua/execute')
        .send({ script: objectScript })
        .expect(200);
      
      expectSuccessResponse(objectResponse, (res) => {
        expect(res.body.result).toEqual({ 
          id: 1, 
          name: 'TestPlayer', 
          score: 100,
          active: true
        });
      });
      
      // Test array return value
      const arrayScript = `
        local players = {"Player1", "Player2", "Player3"}
        return players
      `;
      
      const arrayResponse = await request(app)
        .post('/lua/execute')
        .send({ script: arrayScript })
        .expect(200);
      
      expectSuccessResponse(arrayResponse, (res) => {
        expect(res.body.result).toEqual(['Player1', 'Player2', 'Player3']);
      });
      
      // Test nested structure
      const nestedScript = `
        local gameData = {
          players = {
            {id = 1, name = "Alice"},
            {id = 2, name = "Bob"}
          },
          settings = {
            difficulty = "hard",
            maxPlayers = 4
          },
          scores = {100, 200, 150}
        }
        return gameData
      `;
      
      const nestedResponse = await request(app)
        .post('/lua/execute')
        .send({ script: nestedScript })
        .expect(200);
      
      expectSuccessResponse(nestedResponse, (res) => {
        expect(res.body.result).toEqual({
          players: [
            {id: 1, name: 'Alice'},
            {id: 2, name: 'Bob'}
          ],
          settings: {
            difficulty: 'hard',
            maxPlayers: 4
          },
          scores: [100, 200, 150]
        });
      });
      
    });
});
