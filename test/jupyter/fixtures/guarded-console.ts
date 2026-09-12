/**
 * Child process for `stdout-guard.test.ts`: with the guard installed, nothing
 * a library prints through console.log/info/debug may reach stdout
 * (SPEC.md §11).
 *
 * stdout must contain exactly the two MARKER lines this file writes itself.
 */
import { installStdoutGuard } from '../../../src/jupyter/stdout-guard.js';

const restore = installStdoutGuard();
// A second install must not stack wrappers.
const restoreAgain = installStdoutGuard();

console.log('log-line');
console.info('info-line');
console.debug('Starting WebSocket: ws://127.0.0.1:8888/api/kernels/abc/channels?token=supersecret');
console.error('error-line');
console.warn('warn-line');

process.stdout.write('MARKER-GUARDED\n');

restoreAgain();
restore();
console.log('MARKER-RESTORED');
