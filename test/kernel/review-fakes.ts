/**
 * Adversarial-review doubles for `src/kernel`.
 *
 * Unlike `test/kernel/fake-kernel.ts`, this fake models the *contract* of
 * `KernelClient.requestExecute`: the returned `release()` really unregisters
 * the route, exactly as `KernelClient.registerExecution` does
 * (`src/kernel/kernel-client.ts`, `registerExecution` -> `#routes.delete`).
 * That difference is what makes late-message behaviour observable.
 */

import { DisplayRegistry } from '../../src/kernel/display-registry.js';
import type {
  KernelChangedEvent,
  KernelChangeReason,
  KernelClient,
  KernelObservedStatus,
  RequestExecuteOptions,
  RequestExecuteResult
} from '../../src/kernel/kernel-client.js';
import type { JupyterMessage } from '../../src/kernel/messages.js';
import type { KernelChannelState, KernelExecutionStatus } from '../../src/core/index.js';
import * as fx from './fixtures.js';

export interface Sent {
  readonly msgId: string;
  readonly code: string;
  readonly cellId: string;
  completed: boolean;
}

/** A `KernelClient` stand-in whose `release()` actually stops routing. */
export class RoutingFakeKernel {
  readonly displays = new DisplayRegistry();
  readonly kernelId = 'kernel_review';
  readonly kernelName = 'python3';
  readonly sent: Sent[] = [];
  /** Set to make `requestExecute` throw, like a dead kernel does. */
  throwOnRequest: Error | null = null;

  readonly #routes = new Map<string, (msg: JupyterMessage) => void>();
  readonly #changeListeners = new Set<(event: KernelChangedEvent) => void>();
  readonly #statusListeners = new Set<(status: KernelObservedStatus) => void>();
  #status: KernelObservedStatus = {
    channel: 'connected',
    execution: 'idle',
    observedAt: new Date().toISOString()
  };

  kernelStatus(): KernelObservedStatus {
    return this.#status;
  }

  /** How many executions are currently routed; 0 means nothing is listening. */
  get routeCount(): number {
    return this.#routes.size;
  }

  onKernelChanged(listener: (event: KernelChangedEvent) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onStatusChanged(listener: (status: KernelObservedStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  requestExecute(code: string, options: RequestExecuteOptions): RequestExecuteResult {
    if (this.throwOnRequest !== null) throw this.throwOnRequest;
    const msgId = fx.nextMsgId('rev');
    this.sent.push({ msgId, code, cellId: options.cellId, completed: false });
    const route = options.route;
    if (route !== undefined) this.#routes.set(msgId, route);
    return {
      msgId,
      release: () => {
        this.#routes.delete(msgId);
      }
    };
  }

  /** Deliver one message the way the single receiver would. */
  deliver(msgId: string, msg: JupyterMessage): void {
    this.#routes.get(msgId)?.(msg);
  }

  /** The oldest request that has not been completed yet. */
  pending(): Sent | undefined {
    return this.sent.find((s) => !s.completed);
  }

  /** Complete one request with `reply(ok)` + `idle`, plus optional outputs. */
  complete(msgId: string, executionCount: number, outputs: readonly JupyterMessage[] = []): void {
    for (const msg of outputs) this.deliver(msgId, msg);
    this.deliver(msgId, fx.executeReplyOk(msgId, executionCount));
    this.deliver(msgId, fx.status(msgId, 'idle'));
    const record = this.sent.find((s) => s.msgId === msgId);
    if (record !== undefined) record.completed = true;
  }

  emitKernelChanged(reason: KernelChangeReason): void {
    if (reason !== 'disposed') this.displays.clear();
    const event: KernelChangedEvent = { kernelId: this.kernelId, reason, at: new Date().toISOString() };
    for (const listener of this.#changeListeners) listener(event);
  }

  /** Move the observed channel/execution status, as the real client does. */
  emitStatus(channel: KernelChannelState, execution: KernelExecutionStatus = 'busy'): void {
    this.#status = { channel, execution, observedAt: new Date().toISOString() };
    for (const listener of this.#statusListeners) listener(this.#status);
  }

  asKernelClient(): KernelClient {
    return this as unknown as KernelClient;
  }
}

/** Let queued microtasks and zero-delay timers run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Take over `unhandledRejection` for the duration of a check, so an unhandled
 * rejection produced by the code under test is captured as evidence instead of
 * being reported against the whole test file.
 */
export async function captureUnhandledRejections(
  body: () => Promise<void>
): Promise<unknown[]> {
  const previous = process.listeners('unhandledRejection');
  for (const listener of previous) process.off('unhandledRejection', listener);
  const captured: unknown[] = [];
  const mine = (reason: unknown): void => {
    captured.push(reason);
  };
  process.on('unhandledRejection', mine);
  try {
    await body();
    await sleep(30);
  } finally {
    process.off('unhandledRejection', mine);
    for (const listener of previous) process.on('unhandledRejection', listener);
  }
  return captured;
}
