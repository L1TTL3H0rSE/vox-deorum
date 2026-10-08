/** Native Decisions evaluator using the declared OpenAI SDK's HTTP transport. */
import OpenAI, { type APIError } from 'openai';
import { setTimeout as delay } from 'node:timers/promises';
import type { JSONValue, Experimental_EvaluationModelV4 as EvaluationModel } from '@ai-sdk/provider';
import type { Model } from '../../../types/index.js';
import { getExecutionTimeout } from '../concurrency.js';
import { getDecisionsLimiter } from './decisions-concurrency.js';
import { DecisionsContractError, decisionsText, fromDecisionsResponse, toDecisionsQuestions } from './openai-decisions-contract.js';

/** Total wall-clock budget, including queueing and backoff, capped by the existing execution limit. */
export const decisionsDeadlineMs = 60_000;

/** Per-logical-call evidence, also retained on failures; no request headers or credentials. */
export type DecisionsCall = {
  apiSurface: 'decisions';
  model: string;
  attempts: number;
  durationMs: number;
  outcome: string;
  usage: { attempt: number; raw: JSONValue }[];
  confidence: Record<string, number>;
  rawAnswers: JSONValue;
};

/** A safe evaluation failure carrying the same usage evidence as a successful call. */
export class DecisionsEvaluationError extends Error {
  /** Retain call evidence without retaining SDK request objects, headers, or error bodies. */
  constructor(message: string, readonly call: DecisionsCall) {
    super(message);
    this.name = 'DecisionsEvaluationError';
  }
}

/** Known counts only; missing measurements stay undefined until the numeric sink boundary. */
export type DecisionsUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  complete: boolean;
};

/** Recognize a JSON object without conflating null or an array with usage. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Accept only measured, nonnegative integer token counts. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Extract usable counts while retaining the provider's unmodified raw usage separately. */
export function decisionsUsage(raw: unknown): DecisionsUsage {
  const usage = record(raw);
  const inputTokens = tokenCount(usage?.input_tokens);
  const totalOutput = tokenCount(usage?.output_tokens);
  const reasoningTokens = tokenCount(record(usage?.output_tokens_details)?.reasoning_tokens);
  const outputTokens = totalOutput !== undefined && reasoningTokens !== undefined && reasoningTokens <= totalOutput
    ? totalOutput - reasoningTokens : undefined;
  return {
    inputTokens, outputTokens, reasoningTokens: outputTokens === undefined ? undefined : reasoningTokens,
    cachedInputTokens: tokenCount(record(usage?.input_tokens_details)?.cached_tokens),
    complete: inputTokens !== undefined && outputTokens !== undefined
      && tokenCount(usage?.total_tokens) === inputTokens + (totalOutput ?? 0),
  };
}

/** Reject promptly on abort, even if an underlying transport returns a late response. */
async function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  const cancellation = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([promise, cancellation]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Honor both seconds and HTTP dates; do not retry immediately when a valid delay is too long. */
function retryDelay(error: APIError, attempt: number): number {
  const header = error.headers?.get('retry-after');
  if (header !== null && header !== undefined) {
    // A syntactically numeric delay may overflow Number; infinity still exceeds our deadline.
    if (/^\d+(?:\.\d+)?$/.test(header.trim())) return Number(header) * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 500 * 2 ** (attempt - 1);
}

/** Distinguish transient transport/server failures from requests that must not infer again. */
function retryable(error: unknown): boolean {
  return error instanceof OpenAI.APIConnectionError || (error instanceof OpenAI.APIError
    && (error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500 && error.status <= 599)));
}

/** Validate the deliberately small configuration surface without performing discovery or inference. */
function validateConfig(model: Model): void {
  if (model.name !== 'gpt-6-luna') throw new Error('OpenAI Decisions currently supports model gpt-6-luna.');
  const unsupported = Object.keys(model.options ?? {}).filter(key => key !== 'concurrencyLimit' && key !== 'maxInputTokens');
  if (unsupported.length) throw new Error(`OpenAI Decisions does not support options: ${unsupported.join(', ')}.`);
  const limit = model.options?.concurrencyLimit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('OpenAI Decisions concurrencyLimit must be a positive integer.');
  }
}

/** Build an evaluator; the callback observes one completed logical call and never accrues tokens. */
export function createOpenAIDecisions(model: Model, onComplete?: (call: DecisionsCall) => void): EvaluationModel {
  validateConfig(model);
  return {
    specificationVersion: 'v4', provider: 'openai.decisions', modelId: model.name,
    supportedQuestionTypes: ['boolean', 'choice', 'score'],
    async doEvaluate(options) {
      const started = Date.now();
      const budget = Math.min(decisionsDeadlineMs, getExecutionTimeout(model));
      const deadline = started + budget;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('OpenAI Decisions deadline exceeded.', 'TimeoutError')), budget);
      const signal = options.abortSignal ? AbortSignal.any([controller.signal, options.abortSignal]) : controller.signal;
      const call: DecisionsCall = { apiSurface: 'decisions', model: model.name, attempts: 0, durationMs: 0, outcome: 'error', usage: [], confidence: {}, rawAnswers: null };
      try {
        signal.throwIfAborted();
        const questions = toDecisionsQuestions(options.questions);
        if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI Decisions requires OPENAI_API_KEY.');
        const client = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: budget, logLevel: 'off',
        });
        // Native admission removes cancelled waiters; older provider queues stay unchanged.
        return await getDecisionsLimiter(model).run(async () => {
          for (;;) {
            signal.throwIfAborted();
            call.attempts++;
            const usage = { attempt: call.attempts, raw: null as JSONValue };
            call.usage.push(usage);
            let raw: unknown;
            try {
              // SDK 6.35 has no Decisions resource. Its public transport provides auth and cancellation.
              raw = await abortable(client.post<unknown>('/decisions', {
                body: { model: model.name, input: decisionsText(options.state), questions },
                maxRetries: 0, timeout: Math.max(1, deadline - Date.now()), signal,
              }), signal);
            } catch (error) {
              signal.throwIfAborted();
              if (call.attempts >= 3 || !retryable(error)) {
                const status = error instanceof OpenAI.APIError ? error.status : undefined;
                throw new Error(`OpenAI Decisions request failed${status === undefined ? '' : ` (HTTP ${status})`}.`);
              }
              const wait = error instanceof OpenAI.APIError ? retryDelay(error, call.attempts) : 500 * 2 ** (call.attempts - 1);
              if (wait >= deadline - Date.now()) {
                throw new DOMException('OpenAI Decisions retry delay exceeds the remaining deadline.', 'TimeoutError');
              }
              await delay(wait, undefined, { signal });
              continue;
            }
            // Capture usage before parsing answers: refusals and damaged answers still consumed inference.
            usage.raw = (record(raw)?.usage ?? null) as JSONValue;
            call.rawAnswers = (record(raw)?.answers ?? null) as JSONValue;
            const converted = fromDecisionsResponse(questions, raw);
            signal.throwIfAborted();
            call.confidence = converted.confidence;
            call.outcome = 'success';
            call.durationMs = Date.now() - started;
            const counts = record(usage.raw);
            return {
              answers: converted.answers,
              usage: { inputTokens: tokenCount(counts?.input_tokens), outputTokens: tokenCount(counts?.output_tokens) },
              warnings: [],
              response: { modelId: converted.model, timestamp: new Date(), body: raw },
              providerMetadata: { openai: { ...call, usageComplete: call.usage.every(attempt => decisionsUsage(attempt.raw).complete) } },
            };
          }
        }, signal);
      } catch (error) {
        call.outcome = controller.signal.aborted || (error instanceof Error && error.name === 'TimeoutError') ? 'deadline'
          : signal.aborted ? 'cancelled' : error instanceof DecisionsContractError ? error.kind : 'error';
        // Never attach the SDK error: it may contain provider response text or transport details.
        throw new DecisionsEvaluationError(error instanceof Error ? error.message : 'OpenAI Decisions evaluation failed.', call);
      } finally {
        clearTimeout(timer);
        call.durationMs = Date.now() - started;
        onComplete?.(call);
      }
    },
  };
}
