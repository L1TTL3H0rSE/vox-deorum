/**
 * Tests for get-events tool
 * Tests game events querying functionality through MCP
 */

import { describe, it, expect } from "vitest";
import { mcpClient } from "../../../setup.js";

describe("Get Events Tool via MCP", () => {

  /**
   * Test retrieving all events without filters
   */
  it("should retrieve all events without filters", async () => {
    const result = await mcpClient.callTool({
      name: "get-events",
      arguments: {}
    });

    expect(result.content).toBeDefined();
    const content = (result.content as any)[0];
    expect(content.type).toBe("text");
    
    const parsed = JSON.parse(content.text);
    expect(parsed.Count).toBeDefined();
    expect(typeof parsed.Count).toBe("number");
    expect(parsed.Events).toBeDefined();
    expect(Array.isArray(parsed.Events)).toBe(true);
    
    // Check that if there are events, they have expected fields
    if (parsed.Events.length > 0) {
      const event = parsed.Events[0];
      expect(event.ID).toBeDefined();
      expect(event.Turn).toBeDefined();
      expect(event.Type).toBeDefined();
      expect(event.Payload).toBeDefined();
      // Visibility is optional in the schema
      if (event.Visibility) {
        expect(typeof event.Visibility).toBe("object");
      }
    }
  });

  /**
   * Test filtering events by turn
   */
  it("should filter events by turn", async () => {
    const result = await mcpClient.callTool({
      name: "get-events",
      arguments: {
        Turn: 1
      }
    });

    const content = (result.content as any)[0];
    const parsed = JSON.parse(content.text);
    
    // Removed filters check - not in output schema: expect(// parsed.filters.turn).toBe(1);
    expect(parsed.Events).toBeDefined();
    expect(Array.isArray(parsed.Events)).toBe(true);
    
    // All events should be from turn 1
    parsed.Events.forEach((event: any) => {
      expect(event.Turn).toBe(1);
    });
  });

  /**
   * Test with invalid player ID
   */
  it("should handle invalid player ID", async () => {
    // Invalid PlayerID may surface as a thrown protocol error or an error result
    const failed = await mcpClient.callTool({
      name: "get-events",
      arguments: {
        PlayerID: 25 // Invalid - should be 0-21
      }
    }).then(result => result.isError === true, () => true);

    expect(failed).toBe(true);
  });

  /**
   * Test empty result when no events match filters
   */
  it("should return empty array when no events match", async () => {
    const result = await mcpClient.callTool({
      name: "get-events",
      arguments: {
        Turn: 999999
      }
    });

    const content = (result.content as any)[0];
    const parsed = JSON.parse(content.text);
    
    expect(parsed.Count).toBe(0);
    expect(parsed.Events).toEqual([]);
    // Removed filters check - not in output schema: expect(// parsed.filters.turn).toBe(999999);
  });
});