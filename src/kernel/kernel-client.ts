/**
 * One WebSocket and one receiver for the kernel it is constructed for.
 *
 * SPEC.md §4: "`KernelConnection`: one message receiver per kernel connection,
 * routing by `parent_header.msg_id`, execution queue."
 * Each instance owns exactly one `KernelConnection` and dispatches everything
 * from a single `anyMessage` listener, so one instance can serve any number of
 * notebooks and jobs without competing receivers (SPEC.md §12, "Shared kernel").
 *
 * The class does **not** deduplicate itself: constructing it twice for the
 * same `(server, kernel_id)` opens two sockets. Keeping one instance per
 * `(server, kernel_id)` is the owner's job - the binding layer that resolves
 * kernels for notebooks - because that is where the kernel identity and its
 * lifetime are known.
 *
 * Everything arrives through the single `anyMessage` listener of the
 * underlying `@jupyterlab/services` `KernelConnection`. A message whose
 * `parent_header.msg_id` is one of our registered executions is handed to that
 * execution; anything else - a browser's `execute_request`, another process -
 * only moves the observed execution status, and its outputs are never written
 * into our cells (SPEC.md §8: "`busy` from an external request is taken into
 * account, although its outputs are not written by us").
 *
 * This module builds `ServerConnection.ISettings` nowhere: it takes them, so
 * it stays independent of `src/jupyter`.
 *
 * @module
 */

import { KernelAPI, KernelConnection, type Kernel, type ServerConnection } from '@jupyterlab/services';
import type { KernelChannelState, KernelExecutionStatus } from '../core/types.js';
import { coreError } from '../core/errors.js';
import { DisplayRegistry } from './display-registry.js';
import { fromKernelMessage, parentMsgId, type JupyterMessage } from './messages.js';

/** Observed kernel status, as `kernel_status` reports it (SPEC.md §8). */
export interface KernelObservedStatus {
  readonly channel: KernelChannelState;
  readonly execution: KernelExecutionStatus;
  /** RFC 3339 UTC time of the observation. */
  readonly observedAt: string;
}

/**
 * Why in-flight work is no longer trustworthy (SPEC.md §8: "Observed
 * restart/autorestart/shutdown/dead events or a binding change ... invalidate
 * unfinished jobs and old routes").
 */
export type KernelChangeReason =
  | 'restarting'
  | 'autorestarting'
  | 'terminating'
  | 'dead'
  | 'shutdown'
  | 'disposed';

/** Emitted once per observed lifecycle event. */
export interface KernelChangedEvent {
  readonly kernelId: string;
  readonly reason: KernelChangeReason;
  readonly at: string;
}

/** Receiver of the messages routed to one execution. */
export type ExecutionRoute = (msg: JupyterMessage) => void;

/** Unsubscribe handle. */
export type Unsubscribe = () => void;

/** How to reach one kernel; the settings are built by `src/jupyter`. */
export interface KernelClientOptions {
  /** Settings built by the caller; `src/kernel` never constructs them. */
  readonly serverSettings: ServerConnection.ISettings;
  readonly kernelId: string;
  readonly kernelName?: string;
  /** Forwarded to `KernelConnection`; useful to keep test clients distinct. */
  readonly clientId?: string;
}

/** Arguments of one `execute_request` (SPEC.md §8). */
export interface RequestExecuteOptions {
  /** Written into the request metadata, as JupyterLab does (SPEC.md §8). */
  readonly cellId: string;
  /** Registered before the request is sent, so no message can be missed. */
  readonly route?: ExecutionRoute;
  /** Defaults to `true` (SPEC.md §8). */
  readonly stopOnError?: boolean;
}

/** What a sent `execute_request` gives back to the caller (SPEC.md §8). */
export interface RequestExecuteResult {
  /** `execute_request` header id; the routing key of this execution. */
  readonly msgId: string;
  /** Stops routing for this execution. */
  readonly release: Unsubscribe;
}

function now(): string {
  return new Date().toISOString();
}

/** A live kernel connection with one receiver (SPEC.md §4, §8). */
export class KernelClient {
  readonly #kernel: Kernel.IKernelConnection;
  readonly #serverSettings: ServerConnection.ISettings;
  /** Every observer of one `execute_request`, keyed by its header id. */
  readonly #routes = new Map<string, Set<ExecutionRoute>>();
  readonly #changeListeners = new Set<(event: KernelChangedEvent) => void>();
  readonly #statusListeners = new Set<(status: KernelObservedStatus) => void>();
  /** Per-kernel `display_id` table; it spans executions and cells (§8). */
  readonly displays = new DisplayRegistry();
  #channel: KernelChannelState;
  #execution: KernelExecutionStatus;
  #observedAt: string;
  #disposed = false;

  constructor(options: KernelClientOptions) {
    this.#serverSettings = options.serverSettings;
    const model: Kernel.IModel = { id: options.kernelId, name: options.kernelName ?? 'python3' };
    const connectionOptions: Kernel.IKernelConnection.IOptions = {
      model,
      serverSettings: options.serverSettings,
      handleComms: false,
      ...(options.clientId === undefined ? {} : { clientId: options.clientId })
    };
    this.#kernel = new KernelConnection(connectionOptions);
    this.#channel = this.#kernel.connectionStatus;
    this.#execution = this.#kernel.status;
    this.#observedAt = now();

    this.#kernel.anyMessage.connect(this.#onAnyMessage, this);
    this.#kernel.statusChanged.connect(this.#onStatusChanged, this);
    this.#kernel.connectionStatusChanged.connect(this.#onConnectionStatusChanged, this);
  }

  get kernelId(): string {
    return this.#kernel.id;
  }

  get kernelName(): string {
    return this.#kernel.name;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Channel state, observed execution status and the time of observation. */
  kernelStatus(): KernelObservedStatus {
    return { channel: this.#channel, execution: this.#execution, observedAt: this.#observedAt };
  }

  /**
   * Route every message whose `parent_header.msg_id` is `msgId`.
   *
   * More than one route may observe the same execution - an execution registry
   * keeps its own route alive after `idle` for late output (SPEC.md §8), and a
   * diagnostic observer must not displace it - so registering does not replace
   * an existing route; the returned handle removes only the route it added.
   */
  registerExecution(msgId: string, route: ExecutionRoute): Unsubscribe {
    let routes = this.#routes.get(msgId);
    if (routes === undefined) {
      routes = new Set<ExecutionRoute>();
      this.#routes.set(msgId, routes);
    }
    routes.add(route);
    return () => {
      const current = this.#routes.get(msgId);
      if (current === undefined) return;
      current.delete(route);
      if (current.size === 0) this.#routes.delete(msgId);
    };
  }

  /** Observe restart/autorestart/terminating/dead/shutdown (SPEC.md §8). */
  onKernelChanged(listener: (event: KernelChangedEvent) => void): Unsubscribe {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Observe channel/execution status transitions. */
  onStatusChanged(listener: (status: KernelObservedStatus) => void): Unsubscribe {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /**
   * Send one `execute_request` with `allow_stdin: false` and, by default,
   * `stop_on_error: true` (SPEC.md §8). `cellId` travels in the request
   * metadata, as JupyterLab's executor does.
   *
   * The route is registered as soon as the header id exists, which is still
   * before any answer can be delivered: the socket write is synchronous and
   * incoming frames are dispatched from a later task.
   */
  requestExecute(code: string, options: RequestExecuteOptions): RequestExecuteResult {
    if (this.#disposed) {
      throw coreError('KERNEL_NOT_BOUND', 'kernel client is disposed');
    }
    const future = this.#kernel.requestExecute(
      {
        code,
        allow_stdin: false,
        stop_on_error: options.stopOnError ?? true,
        silent: false,
        store_history: true
      },
      /* disposeOnDone */ true,
      { cellId: options.cellId }
    );
    const msgId = future.msg.header.msg_id;
    // The header id exists only once the request is built, and the socket
    // write is synchronous: a reply can only be delivered from a later task,
    // so registering here still precedes every routed message.
    const release =
      options.route === undefined
        ? (): void => undefined
        : this.registerExecution(msgId, options.route);
    // `future.done` rejects when the kernel is disposed mid-flight; the job
    // outcome is decided by the reducer, so the rejection is only silenced.
    void future.done.catch(() => undefined);
    return { msgId, release };
  }

  /** `POST /api/kernels/<id>/interrupt` (SPEC.md §8, explicit operation). */
  async interrupt(): Promise<void> {
    await this.#kernel.interrupt();
  }

  /** `POST /api/kernels/<id>/restart`; invalidates in-flight work. */
  async restart(): Promise<void> {
    this.#emitChange('restarting');
    // KernelConnection.restart() clears an in-flight automatic kernel-info
    // future while the connection is still live. In @jupyterlab/services
    // 7.6.3 that rejection escapes an internal fire-and-forget promise. The
    // service invalidates and replaces this client after a successful restart,
    // so use the same REST operation without mutating the unsafe connection.
    await KernelAPI.restartKernel(this.kernelId, this.#serverSettings);
  }

  /** `DELETE /api/kernels/<id>`; invalidates in-flight work. */
  async shutdown(): Promise<void> {
    this.#emitChange('shutdown');
    await this.#kernel.shutdown();
  }

  /** Release the socket and every listener. Does not stop the kernel. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#kernel.anyMessage.disconnect(this.#onAnyMessage, this);
    this.#kernel.statusChanged.disconnect(this.#onStatusChanged, this);
    this.#kernel.connectionStatusChanged.disconnect(this.#onConnectionStatusChanged, this);
    this.#routes.clear();
    this.displays.clear();
    this.#kernel.dispose();
    this.#emitChange('disposed');
    this.#changeListeners.clear();
    this.#statusListeners.clear();
  }

  #onAnyMessage(_sender: unknown, args: Kernel.IAnyMessageArgs): void {
    if (args.direction !== 'recv') return;
    const msg = fromKernelMessage(args.msg);
    if (msg.header.msg_type === 'status') {
      const state = (msg.content as { execution_state?: unknown }).execution_state;
      if (typeof state === 'string') this.#setExecution(state as KernelExecutionStatus);
    }
    const parent = parentMsgId(msg);
    if (parent === undefined) return;
    const routes = this.#routes.get(parent);
    // Unrouted: a foreign request. Its status was accounted for above; its
    // outputs are deliberately dropped (SPEC.md §8).
    if (routes === undefined) return;
    for (const route of [...routes]) route(msg);
  }

  #onStatusChanged(_sender: unknown, status: Kernel.IKernelConnection['status']): void {
    this.#setExecution(status);
    if (
      status === 'restarting' ||
      status === 'autorestarting' ||
      status === 'terminating' ||
      status === 'dead'
    ) {
      this.#emitChange(status);
    }
  }

  #onConnectionStatusChanged(_sender: unknown, status: Kernel.ConnectionStatus): void {
    this.#channel = status;
    this.#observedAt = now();
    this.#notifyStatus();
  }

  #setExecution(status: KernelExecutionStatus): void {
    this.#execution = status;
    this.#observedAt = now();
    this.#notifyStatus();
  }

  #notifyStatus(): void {
    const snapshot = this.kernelStatus();
    for (const listener of this.#statusListeners) listener(snapshot);
  }

  #emitChange(reason: KernelChangeReason): void {
    // A lifecycle event makes every recorded display target meaningless.
    if (reason !== 'disposed') this.displays.clear();
    const event: KernelChangedEvent = { kernelId: this.kernelId, reason, at: now() };
    for (const listener of this.#changeListeners) listener(event);
  }
}
