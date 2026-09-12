/**
 * A scripted stand-in for {@link KernelClient}, used by the registry unit
 * tests. It answers `requestExecute` with whatever the test scripts, so queue
 * semantics (SPEC.md §8) can be proven without a Python process.
 */

import type {
  KernelChangedEvent,
  KernelClient,
  KernelObservedStatus,
  RequestExecuteOptions,
  RequestExecuteResult
} from '../../src/kernel/kernel-client.js';
import { DisplayRegistry } from '../../src/kernel/display-registry.js';
import type { JupyterMessage } from '../../src/kernel/messages.js';
import * as fx from './fixtures.js';

export interface SentRequest {
  readonly msgId: string;
  readonly code: string;
  readonly cellId: string;
  readonly stopOnError: boolean;
  /** Feed one message back into the execution that sent this request. */
  readonly deliver: (msg: JupyterMessage) => void;
}

/** Structural fake; cast to `KernelClient` at the call site. */
export class FakeKernelClient {
  readonly displays = new DisplayRegistry();
  readonly sent: SentRequest[] = [];
  readonly kernelId = 'kernel_fake';
  readonly kernelName = 'python3';
  #changeListeners = new Set<(event: KernelChangedEvent) => void>();
  #statusListeners = new Set<(status: KernelObservedStatus) => void>();
  #status: KernelObservedStatus = {
    channel: 'connected',
    execution: 'idle',
    observedAt: new Date().toISOString()
  };

  kernelStatus(): KernelObservedStatus {
    return this.#status;
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
    const msgId = fx.nextMsgId('req');
    const route = options.route;
    this.sent.push({
      msgId,
      code,
      cellId: options.cellId,
      stopOnError: options.stopOnError ?? true,
      deliver: (msg) => route?.(msg)
    });
    return { msgId, release: () => undefined };
  }

  /** Complete the newest request with an ok reply and idle. */
  completeLast(executionCount: number, outputs: readonly JupyterMessage[] = []): void {
    const request = this.sent[this.sent.length - 1];
    if (request === undefined) throw new Error('no request to complete');
    for (const msg of outputs) request.deliver(msg);
    request.deliver(fx.executeReplyOk(request.msgId, executionCount));
    request.deliver(fx.status(request.msgId, 'idle'));
  }

  /** Complete the newest request with a Python error. */
  failLast(executionCount: number, ename = 'ValueError', evalue = 'boom'): void {
    const request = this.sent[this.sent.length - 1];
    if (request === undefined) throw new Error('no request to fail');
    request.deliver(fx.errorMsg(request.msgId, ename, evalue));
    request.deliver(fx.executeReplyError(request.msgId, executionCount, ename, evalue));
    request.deliver(fx.status(request.msgId, 'idle'));
  }

  /** Emit a lifecycle event, as an observed restart/shutdown would. */
  emitKernelChanged(reason: KernelChangedEvent['reason'] = 'restarting'): void {
    const event: KernelChangedEvent = {
      kernelId: this.kernelId,
      reason,
      at: new Date().toISOString()
    };
    this.displays.clear();
    for (const listener of this.#changeListeners) listener(event);
  }

  /** Report a lost channel, as `connectionStatusChanged` would. */
  emitDisconnected(): void {
    this.#status = {
      channel: 'disconnected',
      execution: 'unknown',
      observedAt: new Date().toISOString()
    };
    for (const listener of this.#statusListeners) listener(this.#status);
  }

  asKernelClient(): KernelClient {
    return this as unknown as KernelClient;
  }
}
