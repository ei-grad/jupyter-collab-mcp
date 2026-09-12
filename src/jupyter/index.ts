/**
 * Jupyter transport layer (SPEC.md §5, §6, §11).
 *
 * Three pieces, no state above one server / one room:
 *   - {@link installStdoutGuard} - keeps `@jupyterlab/services` from writing to
 *     the MCP stdio channel;
 *   - {@link ServerClient} - authenticated REST: status, contents, untitled
 *     notebook, collaboration document session, `@jupyterlab/services` settings;
 *   - {@link RtcConnection} - one collaboration room over y-websocket with the
 *     RAW dispatcher and the SPEC.md §6 close-code state machine.
 *
 * @module
 */

export { installStdoutGuard, isStdoutGuardInstalled } from './stdout-guard.js';
export type { RestoreConsole, StdoutGuardOptions } from './stdout-guard.js';

export {
  ROOM_FORMAT,
  ROOM_TYPE,
  deriveWsBaseUrl,
  encodeContentsPath,
  encodeSessionPath,
  isSameOrigin,
  joinUrl,
  normalizeBaseUrl,
  normalizeContentsPath,
  roomName,
  validateNotebookName
} from './paths.js';

export { httpRequest, isSafeMethod, mapHttpStatus, mapTransportError, parseJsonBody } from './http.js';
export type { HttpRequestOptions, HttpResponse } from './http.js';

export { ServerClient } from './server-client.js';
export type {
  CollaborationSession,
  ContentsStat,
  DirectoryEntry,
  DirectoryListing,
  ServerClientOptions,
  ServerStatus
} from './server-client.js';

export {
  CLOSE_BAD_REQUEST,
  CLOSE_INTERNAL,
  CLOSE_NOT_FOUND,
  CLOSE_UNSUPPORTED_DATA,
  classifyClose,
  parseSessionRejection
} from './close-codes.js';
export type { CloseDisposition, SessionRejection } from './close-codes.js';

export {
  MESSAGE_RAW,
  encodeRawJson,
  encodeRawSaveRequest,
  parseRawPayload,
  readRawFrame,
  readRawMessage
} from './raw-protocol.js';
export type { RawMessage, RawSaveStatus } from './raw-protocol.js';

export { Emitter } from './emitter.js';
export type { EventMap } from './emitter.js';

export { SaveRequests } from './save-requests.js';

export { authenticatedWebSocket } from './ws-auth.js';
export type { WebSocketCtor } from './ws-auth.js';

export { RtcConnection, reconnectDelayMs } from './rtc-connection.js';
export type {
  AwarenessUser,
  RtcConnectionEvents,
  RtcConnectionOptions,
  TokenTransport
} from './rtc-connection.js';
