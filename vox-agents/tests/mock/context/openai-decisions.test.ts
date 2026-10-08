/** Real resolver/evaluation/run integration over synthetic HTTP responses, with no provider traffic. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_evaluate } from 'ai';
import { SpanStatusCode } from '@opentelemetry/api';
import { getEvaluationModel, getEvaluatorConfig } from '../../../src/utils/models/evaluation.js';
import { getDecisionsLimiter } from '../../../src/utils/models/providers/decisions-concurrency.js';
import { decisionsDeadlineMs, decisionsUsage, type DecisionsCall } from '../../../src/utils/models/providers/openai-decisions.js';
import { VoxContext } from '../../../src/infra/vox-context.js';
import type { ExecuteTokenOutput } from '../../../src/infra/vox-run.js';
import { makeStrategistParameters } from '../../helpers/fake-vox-context.js';
import { recordSpans } from '../../helpers/recording-tracer.js';
import type { StrategistParameters } from '../../../src/strategist/strategy-parameters.js';

const model = { provider: 'openai-decisions', name: 'gpt-6-luna', options: { concurrencyLimit: 1 } };
const questions = { ready: { type: 'boolean' as const, instructions: 'Synthetic readiness?' } };
const measuredUsage = {
  input_tokens: 17, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
  output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 22, compute_units: 7,
};
const fetchMock = vi.fn<typeof fetch>();
const decisionsLimiter = getDecisionsLimiter(model);

/** Build a fresh synthetic HTTP response. */
function reply(body: unknown = { model: 'gpt-6-luna', answers: [{ name: 'ready', type: 'predicate', probability: 0.8 }], usage: measuredUsage }, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Evaluate through the actual factory and AI SDK; only HTTP is replaced. */
function evaluate(signal?: AbortSignal, onComplete?: (call: DecisionsCall) => void) {
  return experimental_evaluate({ model: getEvaluationModel(model, undefined, onComplete), state: { synthetic: true }, questions, maxRetries: 0, abortSignal: signal });
}

/** Flush SDK promise continuations without advancing a retry or deadline timer. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-decisions-key');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply());

});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();

});

describe('Decisions transport and registry integration', () => {
  it('should send one authenticated Decisions request with only supported fields', async () => {
    const selected = getEvaluatorConfig('agent', { evaluator: 'native', native: model });
    expect(selected).toEqual(model);
    const result = await experimental_evaluate({ model: getEvaluationModel(selected!), state: 'synthetic input', questions, maxRetries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/decisions');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-decisions-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'gpt-6-luna', input: 'synthetic input', questions: [{ name: 'ready', type: 'predicate', instructions: 'Synthetic readiness?' }] });
    expect(result.providerMetadata?.openai).toMatchObject({ apiSurface: 'decisions', model: 'gpt-6-luna', attempts: 1, outcome: 'success', usage: [{ attempt: 1, raw: measuredUsage }], usageComplete: true });
    expect(result.providerMetadata?.typesafe).toBeUndefined();
  });

  it('should require no key or request when no evaluator is selected', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(getEvaluatorConfig('synthetic-unconfigured-agent', { evaluator: undefined as never })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject a missing key before HTTP without exposing credentials', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    await expect(evaluate()).rejects.toThrow('OPENAI_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { ...model, name: 'not-supported' },
    { ...model, options: { temperature: 0 } },
    { ...model, options: { reasoningEffort: 'high' as const } },
    { ...model, options: { concurrencyLimit: 0 } },
  ])('should reject invalid configuration without inference', config => {
    expect(() => getEvaluationModel(config)).toThrow(/OpenAI Decisions/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bounded Decisions execution', () => {
  it.each([400, 401, 403, 422])('should not retry HTTP %s even through experimental_evaluate', async status => {
    fetchMock.mockImplementation(async () => reply({ error: { message: 'synthetic failure' } }, status));
    await expect(evaluate()).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])('should bound real HTTP attempts for %s at three', async status => {
    fetchMock.mockImplementation(async () => reply({ error: { message: 'synthetic transient' } }, status));
    const result = evaluate().catch(error => error);
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should retry a network failure at most twice without SDK retries multiplying attempts', async () => {
    fetchMock.mockRejectedValue(new TypeError('synthetic connection failure'));
    const pending = evaluate().catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should release capacity after an authentication failure', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 401));
    await expect(evaluate()).rejects.toThrow(/401/); await flush();
    expect(decisionsLimiter.activeCount).toBe(0);
    await evaluate(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should honor Retry-After seconds before retrying', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: { message: 'synthetic rate limit' } }, 429, { 'retry-after': '2' }));
    const pending = evaluate(); await flush();
    await vi.advanceTimersByTimeAsync(1999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should honor an HTTP-date Retry-After', async () => {
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    fetchMock.mockResolvedValueOnce(reply({}, 503, { 'retry-after': 'Wed, 07 Oct 2026 12:00:03 GMT' }));
    const pending = evaluate(); await flush();
    await vi.advanceTimersByTimeAsync(2999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should fail rather than bypass Retry-After beyond the deadline', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 429, { 'retry-after': '61' }));
    await expect(evaluate()).rejects.toThrow(/deadline/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should not treat an overflowing Retry-After as permission to retry immediately', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 429, { 'retry-after': '9'.repeat(400) }));
    await expect(evaluate()).rejects.toThrow(/deadline/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should cancel before the request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(evaluate(controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should cancel in backoff without sending another request', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(reply({}, 429, { 'retry-after': '20' }));
    const pending = evaluate(controller.signal).catch(error => error); await flush();
    controller.abort(); expect(await pending).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should cancel during HTTP, release the native slot, and discard a late response', async () => {
    let finish: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController(); const completed = vi.fn();
    const pending = evaluate(controller.signal, completed).catch(error => error); await flush();
    controller.abort(); expect(await pending).toBeInstanceOf(Error); await flush();
    expect(decisionsLimiter.activeCount).toBe(0);
    await evaluate();
    finish(reply()); await flush();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0]).toMatchObject({ outcome: 'cancelled', attempts: 1, usage: [{ attempt: 1, raw: null }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should include queue time in the deadline and never send a cancelled queued call', async () => {
    let release: () => void = () => undefined;
    const held = decisionsLimiter.run(() => new Promise<void>(resolve => { release = resolve; }), new AbortController().signal); await flush();
    const completed = vi.fn(); const pending = evaluate(undefined, completed).catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(decisionsDeadlineMs);
    expect(await pending).toBeInstanceOf(Error);
    expect(completed.mock.calls[0][0]).toMatchObject({ outcome: 'deadline', attempts: 0, durationMs: decisionsDeadlineMs });
    expect(decisionsLimiter.pendingCount).toBe(0);
    expect(decisionsLimiter.activeCount).toBe(1);
    release(); await held; await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(decisionsLimiter.pendingCount).toBe(0);
    await evaluate(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should remove a cancelled waiter immediately while preserving unrelated queued work', async () => {
    let finish: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = evaluate(); await flush();
    const controller = new AbortController(); const second = evaluate(controller.signal).catch(error => error); await flush();
    const third = evaluate(); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decisionsLimiter.pendingCount).toBe(2);
    controller.abort(); expect(await second).toBeInstanceOf(Error);
    expect(decisionsLimiter.pendingCount).toBe(1);
    expect(decisionsLimiter.activeCount).toBe(1);
    finish(reply()); await first; await flush();
    await third;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decisionsLimiter.pendingCount).toBe(0);
    expect(decisionsLimiter.activeCount).toBe(0);
  });

  it('should release capacity when cancellation follows admission but precedes execution', async () => {
    const controller = new AbortController(); const execute = vi.fn(async () => undefined);
    const pending = decisionsLimiter.run(execute, controller.signal).catch(error => error);
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(execute).not.toHaveBeenCalled();
    expect(decisionsLimiter.activeCount).toBe(0);
    await evaluate(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should enforce one deadline across the request and backoff', async () => {
    fetchMock.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 59_000)); return reply({}, 503, { 'retry-after': '2' }); });
    const pending = evaluate().catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await pending).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should time out in HTTP and release capacity without accepting a late success', async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = evaluate().catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(decisionsDeadlineMs);
    expect(await pending).toBeInstanceOf(Error); await flush();
    expect(decisionsLimiter.activeCount).toBe(0);
    await evaluate(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should retain the original deadline after admission from the queue', async () => {
    let release: () => void = () => undefined;
    const held = decisionsLimiter.run(() => new Promise<void>(resolve => { release = resolve; }), new AbortController().signal); await flush();
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = evaluate().catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(30_000); release(); await held; await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBeInstanceOf(Error); await flush();
    expect(decisionsLimiter.activeCount).toBe(0);
  });
});

describe('Decisions usage through the real run boundary', () => {
  it('should reject an oversized state before native inference using the shared input limit', async () => {
    const ctx = new VoxContext<StrategistParameters>({}, 'synthetic-decisions-input-limit');
    const spans = recordSpans(ctx);
    const selected = { ...model, options: { ...model.options, maxInputTokens: 1 } };
    await expect(ctx.withRun({ parameters: makeStrategistParameters() }, () =>
      ctx.evaluate(selected, 'synthetic evidence '.repeat(50), { questions })
    )).rejects.toMatchObject({ __contextLengthError: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spans[0].attributes['evaluate.state_tokens']).toBeGreaterThan(1);
    expect(spans[0].attributes['evaluate.attempts']).toBe(0);
  });

  it('should keep the local input limit out of a valid Decisions request', async () => {
    const ctx = new VoxContext<StrategistParameters>({}, 'synthetic-decisions-bounded-input');
    const selected = { ...model, options: { ...model.options, maxInputTokens: 1000 } };
    await ctx.withRun({ parameters: makeStrategistParameters() }, () =>
      ctx.evaluate(selected, { synthetic: true }, { questions })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'questions']);
    expect(ctx.inputTokens).toBe(17);
  });

  it.each(['success', 'refusal', 'invalid', 'unknown'] as const)('should account once on %s and preserve raw evidence', async outcome => {
    const usage = outcome === 'unknown' ? undefined : measuredUsage;
    const answer = outcome === 'refusal' ? { name: 'ready', type: 'refusal' }
      : { name: 'ready', type: 'predicate', probability: outcome === 'invalid' ? 2 : 0.8 };
    fetchMock.mockResolvedValueOnce(reply({ model: 'gpt-6-luna', answers: [answer], usage }));
    const ctx = new VoxContext<StrategistParameters>({}, `synthetic-decisions-${outcome}`);
    const spans = recordSpans(ctx);
    const tokenOutput: ExecuteTokenOutput = { inputTokens: 0, reasoningTokens: 0, outputTokens: 0 };
    let runTokens: ExecuteTokenOutput | undefined;
    const selected = getEvaluatorConfig('agent', { evaluator: 'native', native: model });
    const result = await ctx.withRun({ parameters: makeStrategistParameters() }, async run => {
      runTokens = run.tokens;
      return ctx.evaluate(selected!, { synthetic: true }, { questions, tokenOutput }).catch(error => error);
    });
    const failed = outcome === 'refusal' || outcome === 'invalid';
    expect(result instanceof Error).toBe(failed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenOutput).toEqual({ inputTokens: usage ? 17 : 0, reasoningTokens: usage ? 2 : 0, outputTokens: usage ? 3 : 0, usageComplete: !!usage });
    expect(runTokens).toEqual(tokenOutput);
    expect([ctx.inputTokens, ctx.reasoningTokens, ctx.outputTokens, ctx.usageComplete]).toEqual([tokenOutput.inputTokens, tokenOutput.reasoningTokens, tokenOutput.outputTokens, !!usage]);
    expect(spans).toHaveLength(1);
    expect(spans[0].status?.code).toBe(failed ? SpanStatusCode.ERROR : SpanStatusCode.OK);
    expect(spans[0].ended).toBe(true);
    expect(spans[0].attributes).toMatchObject({ 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-6-luna', 'gen_ai.api.surface': 'decisions', 'evaluate.attempts': 1, 'tokens.usage.complete': !!usage });
    const metadata = JSON.parse(String(spans[0].attributes['evaluate.provider_metadata']));
    expect(metadata.openai.usage).toEqual([{ attempt: 1, raw: usage ?? null }]);
    expect(metadata.openai.rawAnswers).toEqual([answer]);
    if (!usage) expect(spans[0].attributes).not.toHaveProperty('tokens.input');
    expect(JSON.stringify(spans)).not.toContain('synthetic-decisions-key');
    expect(JSON.stringify(selected)).not.toContain('synthetic-decisions-key');
  });

  it('should preserve known usage after retry without declaring the failed attempt free', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 503));
    const ctx = new VoxContext<StrategistParameters>({}, 'synthetic-decisions-retry');
    const spans = recordSpans(ctx);
    const pending = ctx.withRun({ parameters: makeStrategistParameters() }, () => ctx.evaluate(model, 'synthetic', { questions }));
    await flush(); await vi.advanceTimersByTimeAsync(500); await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.inputTokens).toBe(17); expect(ctx.reasoningTokens).toBe(2); expect(ctx.outputTokens).toBe(3);
    expect(ctx.usageComplete).toBe(false);
    expect(spans[0].attributes).toMatchObject({ 'evaluate.attempts': 2, 'tokens.usage.complete': false });
  });

  it('should not invent zero measurements from invalid or incomplete usage', () => {
    expect(decisionsUsage(null)).toMatchObject({ inputTokens: undefined, outputTokens: undefined, reasoningTokens: undefined, complete: false });
    expect(decisionsUsage({ ...measuredUsage, input_tokens: -1 })).toMatchObject({ inputTokens: undefined, complete: false });
    expect(decisionsUsage({ ...measuredUsage, output_tokens_details: { reasoning_tokens: 6 } })).toMatchObject({ outputTokens: undefined, reasoningTokens: undefined, complete: false });
  });

  it('should forward cancellation from the active run without recording a late success', async () => {
    let finish: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const ctx = new VoxContext<StrategistParameters>({}, 'synthetic-decisions-run-cancel');
    const spans = recordSpans(ctx);
    const pending = ctx.withRun({ parameters: makeStrategistParameters() }, () => ctx.evaluate(model, 'synthetic', { questions })).catch(error => error);
    await flush(); ctx.abort(); expect(await pending).toBeInstanceOf(Error);
    finish(reply()); await flush();
    expect(spans[0].attributes['evaluate.outcome']).toBe('cancelled');
    expect(spans[0].status?.code).toBe(SpanStatusCode.ERROR);
    expect(ctx.inputTokens).toBe(0); expect(ctx.usageComplete).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
