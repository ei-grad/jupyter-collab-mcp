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

/** DOM-shaped WebSocket constructor, as `y-websocket` expects it. */
export type WebSocketCtor = typeof globalThis.WebSocket;

/** Node-shaped constructor that also accepts per-socket options. */
type NodeWebSocketCtor = new (
  url: string | URL,
  protocols?: string | string[],
  options?: unknown
) => WebSocket;

/**
 * Wrap a WebSocket implementation so every socket it creates sends
 * `Authorization: token <token>`.
 *
 * @param token Jupyter token; never stored on the returned class.
 * @param base Implementation to wrap. Defaults to the `ws` package; a browser
 * polyfill that ignores the third constructor argument would silently produce
 * unauthenticated sockets, so pass one only if it supports options.
 */
export function authenticatedWebSocket(
  token: string,
  base: WebSocketCtor = WebSocketImpl as unknown as WebSocketCtor
): WebSocketCtor {
  const options = { headers: { Authorization: `token ${token}` } };
  const Base = base as unknown as NodeWebSocketCtor;

  class AuthenticatedWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, options);
    }
  }

  return AuthenticatedWebSocket as unknown as WebSocketCtor;
}
