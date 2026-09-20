/**
 * Receipt retention and the size of an answer (SPEC.md §9).
 *
 * `receiptMaxBytes` keeps bulk data out of the replay registry, but what a
 * receipt may cost is reserved at acceptance, before the first effect. So an
 * ordinary `notebook_apply` batch - one `OperationResult` per operation, each
 * carrying a cell id and up to three revision digests - stays deduplicated:
 * the exact resend of an accepted request returns the stored answer instead of
 * `REQUEST_ID_EXPIRED`. A batch whose receipt would not fit is refused before
 * the first mutation, with its number still unused.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  isCoreError,
  type CollabService,
  type ServerProfile,
  type Operation
} from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer } from './helpers.js';

const PROFILE: ServerProfile = {
  id: 'main',
  kind: 'standalone',
  apiBaseUrl: 'http://127.0.0.1:8888',
  credentialRef: 'literal:tok'
};

const services: CollabService[] = [];

function rig(): CollabService {
  const server = makeFakeServer({ files: [{ path: 'a.ipynb', type: 'notebook' }] });
  const service = createCollabService(
    { servers: [PROFILE] },
    {
      fetchImpl: server.fetchImpl,
      guardStdout: false,
      openHandle: async (init) => makeFakeHandle(init).handle
    }
  );
  services.push(service);
  return service;
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown('client_request');
});

function addCells(count: number): Operation[] {
  return Array.from({ length: count }, (_, index) => ({
    op: 'add_cell',
    cellType: 'code',
    source: `x = ${index}`,
    position: 'end'
  }));
}

describe('notebook_apply receipts', () => {
  it('replays a 30-operation add_cell batch instead of expiring its receipt', async () => {
    const service = rig();
    const session = await service.sessionOpen({});
    const opened = await service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });

    const operations = addCells(30);
    const args = {
      notebookId: opened.notebook.notebookId,
      requestId: '1',
      operations
    };

    const first = await service.notebookApply(args);
    expect(first.results).toHaveLength(30);
    expect(first.requestAccepted).toBe(true);
    expect(first.replayed).toBe(false);

    // The exact resend of an accepted request must replay the stored answer.
    let replay: Awaited<ReturnType<CollabService['notebookApply']>> | null = null;
    let code = 'no-error';
    try {
      replay = await service.notebookApply(args);
    } catch (error) {
      code = isCoreError(error) ? error.code : `not-core:${String(error)}`;
    }
    expect(code).toBe('no-error');
    expect(replay?.replayed).toBe(true);
    expect(replay?.firstAcceptedAt).toBe(first.firstAcceptedAt);
    expect(replay?.results).toEqual(first.results);

    // ... and it must not apply the batch twice: 1 seed cell + 30 added.
    const summary = await service.notebookRead({
      notebookId: opened.notebook.notebookId,
      view: 'summary'
    });
    expect(summary.summary.cellCount).toBe(31);
  });

  it('refuses a batch whose receipt would not fit, before any mutation', async () => {
    const service = rig();
    const session = await service.sessionOpen({});
    const opened = await service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const notebookId = opened.notebook.notebookId;

    let code = 'no-error';
    let details: unknown;
    try {
      await service.notebookApply({ notebookId, requestId: '1', operations: addCells(4000) });
    } catch (error) {
      code = isCoreError(error) ? error.code : `not-core:${String(error)}`;
      details = isCoreError(error) ? error.details : undefined;
    }
    expect(code).toBe('RESOURCE_LIMIT');
    // Refused before acceptance: the number is untouched and nothing was applied.
    expect(details).toMatchObject({ request_accepted: false, next_request_id: '1' });
    const summary = await service.notebookRead({ notebookId, view: 'summary' });
    expect(summary.summary.cellCount).toBe(1);

    // The same number still accepts a batch that does fit.
    const applied = await service.notebookApply({
      notebookId,
      requestId: '1',
      operations: addCells(2)
    });
    expect(applied.requestAccepted).toBe(true);
    expect(applied.results).toHaveLength(2);
  });
});
