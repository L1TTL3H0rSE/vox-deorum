/**
 * @module envoy/spokesperson
 *
 * Spokesperson envoy agent that represents the current civilization and answers questions diplomatically.
 * Provides diplomatic responses based on the civilization's current state and relationships.
 */

import { LiveEnvoy } from "../live-envoy.js";
import { VoxContext } from "../../infra/vox-context.js";
import { StrategistParameters } from "../../strategist/strategy-parameters.js";
import { EnvoyThread } from "../../types/index.js";
import { worldContext, noDecisionPower, communicationStyle, audienceSection } from "../context/envoy-prompts.js";
import { getTeammateCounterpart } from "../context/diplomacy-context.js";

/**
 * Spokesperson agent that represents the civilization diplomatically.
 * Responds to questions about the civilization's status, relationships, and intentions
 * with appropriate diplomatic framing based on the current game state.
 *
 * @class
 */
export class Spokesperson extends LiveEnvoy {
  /** The spokesperson recites known status using the routine model. */
  public modelSize = 'small' as const;

  /**
   * The name identifier for this agent
   */
  readonly name = "spokesperson";

  /**
   * Human-readable description of what this agent does
   */
  readonly description = "A spokesperson who answers questions about the civilization's status, relationships, and intentions with appropriate diplomatic tact";

  /**
   * Tags for categorizing this agent
   */
  public tags = ["active-game", "diplomatic"];

  /**
   * Extends LiveEnvoy's tool set (get-briefing + send-message) with the MCP get-diplomatic-events tool
   */
  public override getActiveTools(_parameters: StrategistParameters): string[] | undefined {
    return ["get-briefing", "send-message", "get-diplomatic-events"];
  }

  /**
   * Gets the system prompt defining the spokesperson persona
   */
  public async getSystem(
    parameters: StrategistParameters,
    input: EnvoyThread,
    _context: VoxContext<StrategistParameters>
  ): Promise<string> {
    const sections = [
      `You are the official spokesperson serving your civilization.
${worldContext}
You represent your government's interests with diplomatic tact and strategic ambiguity when necessary. ${noDecisionPower}`,

      `# Your Expectation
- You convey your leader's existing viewpoints and positions. Do NOT draft, propose, or negotiate new terms.
- Your purpose is to further your nation's goals and strategies, not to serve or please your audience
- You maintain diplomatic decorum while protecting sensitive information (the bar depends on the diplomatic relationship and audience)
- You answer the audience ONLY by calling the \`send-message\` tool: its \`Message\` is delivered verbatim as your spoken reply. Never write a reply as free text outside the tool. Answer purposefully.`,
    ];

    sections.push(`# Available Tools
- Use the \`send-message\` tool to say something to the counterpart.
  - Write a short, thoughtful message conversationally, within one short paragraph if possible.
  - Never write a reply as free text outside this tool.
- You have a \`get-briefing\` tool to retrieve briefings on Military, Economy, and/or Diplomacy.
  - Call it when you need strategic intelligence.
  - No need to call it for simple greetings or casual diplomatic exchanges.
- You have a \`get-diplomatic-events\` tool to retrieve recent diplomatic history with another player.
  - Call it when you need to reason about intentions, reference past events, or back up your statements with diplomatic history.`);

    sections.push(communicationStyle);
    sections.push(audienceSection(this.formatUserDescription(input), getTeammateCounterpart(parameters, input)));

    return sections.join('\n\n').trim();
  }

  /**
   * The spokesperson's normal-mode nudge appended after the hint: every response reflects
   * on the leader's standing.
   */
  protected override getDefaultAddon(): string {
    return "Every response reflects on our leader's leadership and your civilization's standing.";
  }
  
  /** Spokesperson run at the default reasoning tier. */
  protected reasoningTier = "default" as const;
}
