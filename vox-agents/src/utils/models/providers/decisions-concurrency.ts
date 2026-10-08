/** Cancellable admission for Decisions, without changing older providers' queues. */
import type { Model } from '../../../types/index.js';

/** A FIFO semaphore whose cancelled waiters immediately release their captured input. */
class DecisionsLimiter {
  activeCount = 0;
  private readonly waiting = new Set<() => void>();

  /** Use the same default and first-configuration policy as existing model limiters. */
  constructor(readonly concurrency: number) {}

  /** Report queued calls, excluding cancelled or admitted waiters. */
  get pendingCount(): number { return this.waiting.size; }

  /** Reserve capacity before waking a waiter and always release it after execution. */
  async run<T>(execute: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      /** Detach this waiter without disturbing other queued calls. */
      const cancel = () => {
        this.waiting.delete(start);
        signal.removeEventListener('abort', cancel);
        reject(signal.reason);
      };
      /** Reserve the slot synchronously, so new arrivals cannot overtake this waiter. */
      const start = () => {
        this.waiting.delete(start);
        signal.removeEventListener('abort', cancel);
        this.activeCount++;
        resolve();
      };
      if (this.activeCount < this.concurrency) start();
      else {
        this.waiting.add(start);
        signal.addEventListener('abort', cancel, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await execute();
    } finally {
      this.activeCount--;
      this.waiting.values().next().value?.();
    }
  }
}

const decisionsLimiters = new Map<string, DecisionsLimiter>();

/** Share a native model's capacity across evaluator instances and seat overrides. */
export function getDecisionsLimiter(model: Model): DecisionsLimiter {
  const key = `${model.provider}/${model.name}`;
  let limiter = decisionsLimiters.get(key);
  if (!limiter) {
    limiter = new DecisionsLimiter(model.options?.concurrencyLimit ?? 5);
    decisionsLimiters.set(key, limiter);
  }
  return limiter;
}
