/**
 * Child process for `stdout-guard.test.ts`: the real reproduction of
 * spike/NOTES.md §3.4 - `@jupyterlab/services` calls `console.debug`
 * ("Starting WebSocket: …") while constructing a `KernelConnection`.
 *
 * The guard is installed first and the package is loaded with a dynamic
 * `import()` afterwards, because ESM hoists static imports.
 */
import type { ServerConnection as ServerConnectionTypes } from '@jupyterlab/services';

import { installStdoutGuard } from '../../../src/jupyter/stdout-guard.js';

// `GUARD=0` skips the guard: the test uses that run as the control, proving
// the library really does write to stdout without it.
if (process.env['GUARD'] !== '0') installStdoutGuard();

const { KernelManager, ServerConnection } = await import('@jupyterlab/services');
const { default: WebSocketImpl } = await import('ws');

const serverSettings = ServerConnection.makeSettings({
  // Port 1 refuses connections; we only care about the console output that
  // happens while the socket is being created.
  baseUrl: 'http://127.0.0.1:1/',
  wsUrl: 'ws://127.0.0.1:1/',
  token: 'supersecret',
  appendToken: true,
  WebSocket: WebSocketImpl as unknown as typeof globalThis.WebSocket,
  fetch: fetch as unknown as ServerConnectionTypes.ISettings['fetch']
});

const manager = new KernelManager({ serverSettings, standby: 'never' });
const kernel = manager.connectTo({
  model: { id: '00000000-0000-0000-0000-000000000000', name: 'python3' }
});

await new Promise((resolve) => setTimeout(resolve, 400));

kernel.dispose();
manager.dispose();
process.stdout.write('MARKER-KERNEL\n');
process.exit(0);
