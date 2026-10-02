/**
 * Tests for the OpenAI ChatCompletion → Vercel StepResult format converter.
 */
import { describe, it, expect } from 'vitest';
import { convertToStepResult } from '../../../src/oracle/batch/format-converter.js';

/** Build a minimal ChatCompletion-like response for conversion tests */
function makeResponse(overrides: Record<string, any> = {}): any {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello world' },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  };
}

describe('convertToStepResult', () => {
  describe('text responses', () => {
    it('should produce a single step with the message text', async () => {
      const { steps } = await convertToStepResult(makeResponse());
      expect(steps).toHaveLength(1);
      expect(steps[0].text).toBe('Hello world');
      expect(steps[0].toolCalls).toEqual([]);
      expect(steps[0].finishReason).toBe('stop');
    });

    it('should build an assistant response message with a text part', async () => {
      const { steps } = await convertToStepResult(makeResponse());
      const messages = steps[0].response.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toEqual([{ type: 'text', text: 'Hello world' }]);
    });

    it('should treat null content as empty text', async () => {
      const response = makeResponse();
      response.choices[0].message.content = null;
      const { steps } = await convertToStepResult(response);
      expect(steps[0].text).toBe('');
      expect(steps[0].content).toEqual([]);
      // With no content parts, the assistant message falls back to plain text
      expect(steps[0].response.messages[0].content).toBe('');
    });

    it('should map usage token counts', async () => {
      const response = makeResponse();
      response.usage.completion_tokens_details = { reasoning_tokens: 3 };
      const { steps } = await convertToStepResult(response);
      expect(steps[0].usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        outputTokenDetails: { reasoningTokens: 3 },
      });
    });

    it('should default usage to zero when absent', async () => {
      const response = makeResponse({ usage: undefined });
      const { steps } = await convertToStepResult(response);
      expect(steps[0].usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        outputTokenDetails: { reasoningTokens: 0 },
      });
    });
  });

  describe('tool call responses', () => {
    /** Response with one function tool call carrying JSON arguments */
    function makeToolResponse(argsJson: string): any {
      const response = makeResponse();
      response.choices[0].message.content = null;
      response.choices[0].message.tool_calls = [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get-data', arguments: argsJson },
        },
      ];
      response.choices[0].finish_reason = 'tool_calls';
      return response;
    }

    it('should convert function tool calls with parsed JSON args', async () => {
      const { steps } = await convertToStepResult(makeToolResponse('{"playerId": 3}'));
      expect(steps[0].toolCalls).toEqual([
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'get-data',
          input: { playerId: 3 },
        },
      ]);
      expect(steps[0].finishReason).toBe('tool-calls');
      // Tool calls also appear as content parts and in the response message
      expect(steps[0].content).toEqual(steps[0].toolCalls);
      expect(steps[0].response.messages[0].content).toEqual(steps[0].toolCalls);
    });

    it('should keep malformed JSON arguments as the raw string', async () => {
      const { steps } = await convertToStepResult(makeToolResponse('{not json'));
      expect(steps[0].toolCalls[0].input).toBe('{not json');
    });

    it('should filter out non-function tool calls', async () => {
      const response = makeToolResponse('{}');
      response.choices[0].message.tool_calls.push({
        id: 'call_2',
        type: 'custom',
        custom: { name: 'whatever', input: '' },
      });
      const { steps } = await convertToStepResult(response);
      expect(steps[0].toolCalls).toHaveLength(1);
      expect(steps[0].toolCalls[0].toolCallId).toBe('call_1');
    });

    it('should combine text and tool call content parts', async () => {
      const response = makeToolResponse('{"a":1}');
      response.choices[0].message.content = 'Calling a tool';
      const { steps } = await convertToStepResult(response);
      expect(steps[0].content).toHaveLength(2);
      expect(steps[0].content[0]).toEqual({ type: 'text', text: 'Calling a tool' });
      expect(steps[0].content[1].type).toBe('tool-call');
    });
  });

  describe('tool input hooks', () => {
    /** Response with one call to each named tool, in order */
    function makeCallsResponse(names: string[]): any {
      const response = makeResponse();
      response.choices[0].message.content = null;
      response.choices[0].message.tool_calls = names.map((name, i) => ({
        id: `call_${i}`,
        type: 'function',
        function: { name, arguments: '{"x":1}' },
      }));
      response.choices[0].finish_reason = 'tool_calls';
      return response;
    }

    /** A hook that rejects every call to its tool */
    const reject = () => { throw new Error('not available'); };

    it('marks only the rejected call invalid and answers it with an error result', async () => {
      const { steps } = await convertToStepResult(makeCallsResponse(['a', 'b']), { b: reject });
      const [kept, rejected] = steps[0].toolCalls;
      expect(kept.invalid).toBeUndefined();
      expect(rejected.invalid).toBe(true);
      expect(rejected.toolName).toBe('b');

      // The step content gains a tool-error for the rejected call only.
      const errors = steps[0].content.filter((part: any) => part.type === 'tool-error');
      expect(errors.map((part: any) => part.toolCallId)).toEqual(['call_1']);

      // The response messages answer the rejected call, so the next step sees why it did not run.
      const [assistant, tool] = steps[0].response.messages;
      expect(assistant.content.map((part: any) => part.toolCallId)).toEqual(['call_0', 'call_1']);
      expect(assistant.content.every((part: any) => part.invalid === undefined)).toBe(true);
      expect(tool.role).toBe('tool');
      expect(tool.content).toHaveLength(1);
      expect(tool.content[0].toolCallId).toBe('call_1');
      expect(tool.content[0].output).toEqual({ type: 'error-text', value: 'not available' });
    });

    it('replaces the input with what a passing hook returns', async () => {
      const { steps } = await convertToStepResult(makeCallsResponse(['a']), { a: (input) => ({ ...input, y: 2 }) });
      expect(steps[0].toolCalls[0].input).toEqual({ x: 1, y: 2 });
      expect(steps[0].toolCalls[0].invalid).toBeUndefined();
    });

    it('adds no tool message when nothing is rejected', async () => {
      const { steps } = await convertToStepResult(makeCallsResponse(['a']), { b: reject });
      expect(steps[0].response.messages).toHaveLength(1);
    });
  });

  describe('finish reason mapping', () => {
    /** Convert with a given OpenAI finish_reason and return the mapped value */
    async function mapReason(reason: string | null): Promise<string> {
      const response = makeResponse();
      response.choices[0].finish_reason = reason;
      return (await convertToStepResult(response)).steps[0].finishReason;
    }

    it('should map known reasons to Vercel equivalents', async () => {
      expect(await mapReason('stop')).toBe('stop');
      expect(await mapReason('length')).toBe('length');
      expect(await mapReason('tool_calls')).toBe('tool-calls');
      expect(await mapReason('content_filter')).toBe('content-filter');
    });

    it('should map unknown or null reasons to unknown', async () => {
      expect(await mapReason(null)).toBe('unknown');
      expect(await mapReason('something_else')).toBe('unknown');
    });
  });

  describe('responses without choices', () => {
    it('should return an empty step preserving usage', async () => {
      const response = makeResponse({ choices: [] });
      const { steps } = await convertToStepResult(response);
      expect(steps).toHaveLength(1);
      expect(steps[0].text).toBe('');
      expect(steps[0].toolCalls).toEqual([]);
      expect(steps[0].finishReason).toBe('unknown');
      expect(steps[0].usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        outputTokenDetails: { reasoningTokens: 0 },
      });
      expect(steps[0].response.messages).toEqual([]);
    });
  });
});
