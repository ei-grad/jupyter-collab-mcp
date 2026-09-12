/**
 * Tiny HTTP stub for the `ServerClient` unit tests.
 *
 * Records every request (method, URL, headers) so the tests can assert that the
 * token travels in the `Authorization` header and never in a URL (SPEC.md §11).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export type StubHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string
) => void;

export interface HttpStub {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  setHandler(handler: StubHandler): void;
  close(): Promise<void>;
}

/** Start the stub on an ephemeral port of 127.0.0.1. */
export function startHttpStub(initial: StubHandler): Promise<HttpStub> {
  const requests: RecordedRequest[] = [];
  let handler = initial;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        authorization: request.headers.authorization,
        body
      });
      handler(request, response, body);
    });
  });

  return new Promise<HttpStub>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        setHandler(next: StubHandler): void {
          handler = next;
        },
        close(): Promise<void> {
          return new Promise((done, fail) => {
            server.closeAllConnections();
            server.close((error) => (error ? fail(error) : done()));
          });
        }
      });
    });
  });
}

/** Reply with JSON. */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(text);
}
