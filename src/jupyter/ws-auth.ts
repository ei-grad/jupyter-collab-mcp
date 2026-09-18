/**
 * WebSocket constructor that authenticates in the handshake header
 * (SPEC.md §11).
 *
 * A browser cannot set headers on a WebSocket handshake, which is why
 * jupyter-collaboration's own docprovider appends `?token=` to the room URL.
 * Node can, and `jupyter_server` accepts `Authorization: token <t>` on the
 * collaboration room upgrade exactly as it does on REST (verified against
 * jupyter_server 2.21.0 / jupyter_server_ydoc 3.0.2: header → 101, no
 * credential at all → 403).
 *
 * Keeping the token out of the URL matters because `y-websocket` stores the
 * connection parameters in the public, enumerable `provider.params` and
 * recomputes `provider.url` from them, so anything that dumps a provider - a
 * `console.log`, a `util.inspect`, a serialized diagnostic - would otherwise
 * print the credential (SPEC.md §11).
 *
 * The token lives only in the closure below: the returned class has no field
 * holding it, so inspecting the class or an instance does not reveal it. The
 * one exception is a socket still performing its handshake, whose underlying
 * `ClientRequest` carries the header until the upgrade completes.
 *
 * @module
 */

import WebSocketImpl from 'ws';
import { assertionDeadline } from './auth-expiry.js';

/** DOM-shaped WebSocket constructor, as `y-websocket` expects it. */
export type WebSocketCtor = typeof globalThis.WebSocket;

/** Node-shaped constructor that also accepts per-socket options. */
type NodeWebSocketCtor = new (
  url: string | URL,
  protocols?: string | string[],
  options?: unknown
) => WebSocket;

/** Failed handshakes remain asynchronous, as reconnecting SDKs expect. */
class CredentialUnavailableSocket extends EventTarget {
  readonly url = '';
  readonly protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;

  constructor() {
    super();
    queueMicrotask(() => this.close());
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = Object.assign(new Event('close'), {
      code: 1006, reason: 'credential unavailable', wasClean: false
    }) as CloseEvent;
    this.dispatchEvent(event);
    this.onclose?.(event);
  }

  send(): void {
    throw new Error('credential unavailable');
  }
}

/**
 * Wrap a WebSocket implementation so every socket it creates sends
 * `Authorization: token <token>`, or the supplied external assertion headers.
 *
 * @param token Jupyter token; never stored on the returned class.
 * @param base Implementation to wrap. Defaults to the `ws` package; a browser
 * polyfill that ignores the third constructor argument would silently produce
 * unauthenticated sockets, so pass one only if it supports options.
 */
export function authenticatedWebSocket(
  token: string,
  base: WebSocketCtor = WebSocketImpl as unknown as WebSocketCtor,
  authHeaders?: Readonly<Record<string, string>>,
  resolveAuthHeaders?: () => Readonly<Record<string, string>>,
  credentialExpiry?: 'jwt',
  credentialExpiresAt?: number
): WebSocketCtor {
  const Base = base as unknown as NodeWebSocketCtor;

  class AuthenticatedWebSocket extends Base {
    readonly #deadline: number | undefined;

    constructor(url: string | URL, protocols?: string | string[]) {
      let headers: Readonly<Record<string, string>>;
      let deadline: number | undefined;
      try {
        headers = resolveAuthHeaders?.() ?? authHeaders ?? { Authorization: `token ${token}` };
        deadline = credentialExpiry === 'jwt'
          ? assertionDeadline(Object.values(headers)[0] ?? '', credentialExpiresAt) : undefined;
      } catch {
        return new CredentialUnavailableSocket() as unknown as AuthenticatedWebSocket;
      }
      super(url, protocols, { headers, followRedirects: false });
      this.#deadline = deadline;
      if (deadline !== undefined) {
        // Jupyter treats 1000/1001 as terminal; renewal must permit reconnect.
        const timer = setTimeout(() => this.close(4000, 'credential expired'),
          Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
        timer.unref();
        this.addEventListener('close', () => clearTimeout(timer), { once: true });
      }
    }

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
        this.close(4000, 'credential expired');
        return;
      }
      super.send(data);
    }
  }

  return AuthenticatedWebSocket as unknown as WebSocketCtor;
}
