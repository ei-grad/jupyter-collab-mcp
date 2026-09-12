/**
 * Reviewer fixture: a whole RTC lifecycle - connect, save, forced reconnect,
 * mid-session 1003 rejection, dispose - in a child process.
 *
 * Two properties are checked by the test that spawns this file:
 *   - SPEC.md §11 / §12 "Cleanup and credentials": stdout stays empty and no
 *     token appears on either stream, including during reconnect and failure;
 *   - SPEC.md §4: `dispose()` releases every handle, so the process exits on
 *     its own. `process.exit()` is deliberately NOT called.
 */
import * as Y from 'yjs';

import { installStdoutGuard } from '../../../src/jupyter/stdout-guard.js';
import { RtcConnection } from '../../../src/jupyter/rtc-connection.js';
import { FakeRtcServer } from '../../jupyter/helpers/fake-rtc-server.js';

installStdoutGuard();

const TOKEN = 'LIFECYCLE-TOKEN-abc123';
const FILE_ID = 'lifecycle-file';

const server = await FakeRtcServer.start({});
const ydoc = new Y.Doc();
const connection = new RtcConnection({
  wsBaseUrl: server.baseUrl,
  token: TOKEN,
  fileId: FILE_ID,
  sessionId: 'lifecycle-session',
  ydoc,
  awarenessUser: { name: 'reviewer', color: '#0000ff' },
  maxBackoffTime: 50,
  saveTimeoutMs: 1_000
});

const reached = (target: string, timeoutMs = 10_000): Promise<void> =>
  new Promise((resolve, reject) => {
    if (connection.state === target) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${target}`));
    }, timeoutMs);
    const off = connection.on('state', (state) => {
      if (state !== target) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });

await connection.connect(10_000);
ydoc.getMap('cells').set('a', 1);
process.stderr.write(`save=${await connection.save(2_000)}\n`);

server.dropAll();
await reached('reconnecting');
await reached('ready');
process.stderr.write(`generation=${String(connection.socketGeneration)}\n`);

server.accepted[connection.socketGeneration - 1]?.close(
  1003,
  JSON.stringify({ reason: 'unknown_session', sessionId: 'other', reloadable: true })
);
await reached('failed');
process.stderr.write(`terminal=${String(connection.terminalError?.code)}\n`);
process.stderr.write(`url=${connection.url}\n`);

connection.dispose();
ydoc.destroy();
await server.close();
process.stderr.write('MARKER-DONE\n');
// No process.exit(): a leaked timer, socket or interval keeps this alive.
