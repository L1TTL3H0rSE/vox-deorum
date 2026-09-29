import { describe, it, expect } from "vitest";
import { mcpClient } from "../../../setup.js";

describe("Calculator Tool via MCP", () => {

  it("should execute basic calculations", async () => {
    const testCases = [
      { Expression: "2 + 3", expected: 5 },
      { Expression: "10 * 5", expected: 50 },
      { Expression: "sqrt(16)", expected: 4 },
      { Expression: "2^8", expected: 256 },
      { Expression: "(10 + 5) * 2", expected: 30 }
    ];

    for (const test of testCases) {
      const result = await mcpClient.callTool({
        name: "calculator",
        arguments: { Expression: test.Expression }
      });

      const content = (result.content as any)[0];
      expect(content.type).toBe("text");
      expect(JSON.parse(content.text).Result).toBe(test.expected);
    }
  });

  it("should handle complex expressions", async () => {
    const result = await mcpClient.callTool({
      name: "calculator",
      arguments: { Expression: "pi * 2" }
    });

    const content = (result.content as any)[0];
    expect(content.type).toBe("text");
    expect(JSON.parse(content.text).Result).toBeCloseTo(6.283185307);
  });

  it("should handle errors gracefully", async () => {
    const result = await mcpClient.callTool({
      name: "calculator",
      arguments: { Expression: "invalid expression @#$" }
    });

    expect(result.isError).toBe(true);
  });
});