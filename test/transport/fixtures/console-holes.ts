/**
 * Reviewer fixture: which console methods still reach stdout while
 * `installStdoutGuard()` is active (SPEC.md §11 - stdout is the MCP channel).
 */
import { installStdoutGuard } from '../../../src/jupyter/stdout-guard.js';

installStdoutGuard();

console.log('log');
console.info('info');
console.debug('debug ws://h/api/collaboration/room/json:notebook:x?token=SUPERSECRET');
console.table([{ a: 1 }]);
console.group('group');
console.groupEnd();
console.count('counter');
console.dir({ url: 'ws://h/api?token=SUPERSECRET' });
console.dirxml({ url: 'ws://h/api?token=SUPERSECRET' });
