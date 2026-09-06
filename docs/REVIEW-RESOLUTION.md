# SPEC.md review resolution

Date: 2026-09-06. Result: [SPEC.md](../SPEC.md) corrected.
This was a review of source code and project contracts, without running
Jupyter, changing environments, or implementing the client. In the tables,
"resolved" means that the specification was corrected; integration validation
still remains to be done.

## Material findings

| No. | Validation and resolution | Future implementation validation | Status |
| --- | --- | --- | --- |
| 1. Reconnect/conflict | Store/version checks, 1003 JSON, and 4400/4404/4500 were confirmed. The missing `initialization_error` was added. Restart with a known compatible session is allowed. A RAW conflict occurs on a SYNC `RuntimeError` with `block parent`, not on every eviction. Important correction: browser disposal applies to 1003; the RAW handler presents recovery options and does not itself dispose of the model. Terminal `failed` state and the prohibition on resending the Y.Doc after RAW are the selected headless policy. The 2.x behavior was checked separately on v2.1.5 and was not generalized to every version. [S1], [S2], [S3], [S4] | §12: Session compatibility; RAW and eviction | Resolved |
| 2. External write | `rooms.py` does call `aset`; the MCP retains the room. However, YDoc 4.1.1 preserves unchanged IDs/objects and produces granular updates where possible. Not all IDs/revisions/cursors necessarily expire. Invalidation is defined by actual structure/fields and replacement of a Y.Map, even when the ID remains unchanged; a change cursor remains valid until journal eviction. [S1], [S3], [S5] | §12: External write, including a retained ID with a new Y.Map | Resolved with a correction |
| 3. Shared execution | `execution_state`, `clearExecution`, and the association between `[*]` and running state were confirmed on compatible JupyterLab 4.6.3. Clearing outputs/count/timing, running/idle state with a generation check, and `state.document_id` after sync were added. The count is published on completion so that an early count does not clear the prompt. `clearExecution` belongs to the JupyterLab model; the historical "4.2+" threshold was not separately verified. [S4], [S6], [S7] | §12: Shared execution; absence of a kernel does not clear output | Resolved |
| 4. Type 2 | Jupyter RAW and y-websocket auth both use message type 2. A separate dispatch before the auth decoder or a replacement handler is required; the listener must serve the current socket after reconnect. [S4], [S8] | §12: multiple reconnects, save replies, and conflict handling without missing or duplicate handlers | Resolved |
| 5. Deduplication/limits | The unbounded-growth problem was resolved. The proposed best-effort ring was rejected because it would permit repeated execution. `request_id` is a sequential number within a session, and `H` is retained independently of the bounded receipt cache. An evicted number returns `REQUEST_ID_EXPIRED` without an effect. Memory is reserved before accepting the request; active entries are not evicted. Exactly-once behavior across a restart/new session is not promised. | §12: more than 4,096 operations, reuse of an evicted number, concurrent duplicate, full active registry | Resolved with a different design |

## Other findings

| Finding | Resolution and rationale | Status |
| --- | --- | --- |
| Name during create | By user decision, the standard manager is supported: newUntitled → rename when `name` is provided → open room. Both untitled creation and rename have a TOCTOU race; the same residual risk is documented without promising atomicity. On 409/403 after creation, the untitled file remains and the response reports its path and `applied`; there is no automatic deletion. The previous prohibition on naming was removed. [S9], [S15] | Resolved by user decision |
| Incomplete set of apply operations | Key-level cell/notebook metadata changes and their corresponding revisions were added. Changing the type of an existing cell and writing attachments are explicitly deferred; reading and preserving them unchanged are mandatory. | Resolved |
| Initial changes cursor | Open/create/read return a consistent `changes_cursor`; the page cursor has a different type. Snapshot creation and journal flush leave no update-loss window. | Resolved |
| Required `server_id` | In `session_open`, it is optional only when selection is unambiguous; multiple servers produce `SERVER_SELECTION_REQUIRED`. | Resolved |
| Execution without a kernel | `KERNEL_NOT_BOUND` is returned before outputs are cleared or code is sent; there is no automatic startup. | Resolved |
| Other parties' kernel events | Connection status and observed execution status are separate, including another party's busy and terminating states. Observed restart/shutdown/dead events invalidate old jobs/routes; a WS disconnect alone does not prove restart/shutdown. An indeterminate result remains unknown. | Resolved |
| Duplicate `cell_id` | `CELL_ID_AMBIGUOUS` is returned for an operation/anchor addressing such an ID. During serialization, YDoc changes the ID of a differing duplicate in the live model; an exact duplicate is omitted only from the serialized result. SPEC now requires updating the index and earlier targets when an ID changes. [S5] | Resolved |
| Sequencing/pipelining | Sequential launch with a check before every send was explicitly selected. The queue is visible in execution tools; only a sent cell is running. `stop_on_error=true`; `not_sent` is distinct from kernel `aborted`. | Resolved |
| Autosave | Exact v5.0.2 formula: `any(state.get("autosave", True))` over non-empty states; true when states are absent. The MCP publishes true, preserving autosave even when the browser publishes false. Debounce does not count as revision confirmation. [S3] | Resolved with clarification |
| Starting Jupyter from the skill | §10 contains an external uvx recipe and use of the project environment. This is a candidate for step 1, not an already validated JupyterLab/Collaboration/YDoc stack; MCP automatic startup was not added. | Resolved |
| Unified errors | §9 provides a code/retryable/side_effects table with an override rule after an effect and separate semantics for accepted/expired requests. Python errors remain job results. | Resolved |
| Output journal | Pending updates are coalesced per cell before publication; published sequence numbers are immutable. The journal is flushed before snapshots/cursors and at generation boundaries; 10,000 limits records, not IOPub messages. | Resolved |
| Resource links and lifetime | The resources capability, read/list, and the concrete `output_read` tool fallback were introduced for the project's own output URIs. No universal MUST for every `resource_link` was found in the tools specification; this is a requirement of this project's delivery mechanism. Lifetime was added to creation tools. Stateful Tools is non-normative guidance; `HANDLE_EXPIRED` is a project-defined name, not one specified by MCP. [S10], [S11] | Resolved with a correction |
| Two sessions for one notebook | Two Y.Docs and two WebSockets are an explicit lifecycle-isolation choice; memory is counted twice. For future shared HTTP deployment, handles are bound to the authenticated owner. | Resolved |

## Follow-up review clarifications

| Item | Final contract | Status |
| --- | --- | --- |
| Equivalent creation guarantees | Both untitled and named creation are allowed with the standard manager; an existing target produces `ALREADY_EXISTS` while retaining the untitled path. The residual concurrent-overwrite risk is documented and was accepted by the user. The current manager 2.21.0 was checked separately. [S9], [S15] | Resolved |
| Versions | Meta 5.0.2 requires Lab >=4.6.0,<5 and server-ydoc >=3.0.2,<4. UI references were updated to Lab 4.6.3; the server store uses server-ydoc 3.0.2 from the tag. Docprovider requires y-websocket ^1.3.15, and the upstream lockfile selects 1.5.4. The PyPI/npm cross-check and the distinction between candidate 1.5.4 and latest 3.1.0 were added to SPEC. [S7], [S8], [S16] | Resolved |
| Sequential `request_id` | The mutating-tool descriptions and the skill require sequential calls within one session, using the number from the latest response/read-only recovery. Calls for different sessions and reads may run in parallel; execution of the returned job may continue. | Resolved |
| Retry after context loss | A replay is marked `replayed=true` and retains the original `first_accepted_at`; `next_request_id` is always current. A new identical intent requires a fresh number. The distinct outcomes of parallel calls are clarified: replay, payload conflict, or ordering violation. | Resolved |
| Status and serialization | Terminating state and the observable change of a duplicate ID during serialization were added. Writing execution count early is deferred until completion to preserve the running prompt. | Resolved |
| Presentation | Repeated contrasts in SPEC and CONNECTIONS were replaced with direct descriptions of actions and boundaries. Contracts were preserved. | Resolved |

## Verified upstream claims and boundaries

As of the review date, GitHub releases/latest returns Collaboration v5.0.2
(2026-08-25) and YDoc v4.1.1 (2026-07-06). This does not establish that they
are compatible when run together. MCP 2026-07-28 includes Statelessness,
Stateful Tools, `isError`, `structuredContent`, and `outputSchema`; Stateful
Tools is under server/tools, not basic. [S10], [S12], [S13], [S14]

The room/sessionId handshake, `disableBc`, and document_id were verified against
docprovider. The observations in §2 of SPEC about the previously inspected
dirty copy of the Python client were retained; that copy was neither changed
nor rerun. The cause of the segfault remains unknown. The choice of client-side
execution and a deferred server-side adapter is unchanged. The local revision
check was not upgraded to distributed CAS.

Edit validation comprised a complete review of 5 material and 14 other
findings; the pinned upstream files and final diff were read, and
`git diff --check` was run. Runtime validation, browser tests, and benchmarks
were not run: §12 defines their future criteria and does not report successful
execution.

## Sources

- [S1: handlers v5.0.2](https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-server-ydoc/jupyter_server_ydoc/handlers.py#L247-L331).
- [S2: session compatibility v5.0.2](https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-server-ydoc/jupyter_server_ydoc/utils.py#L168-L207).
- [S3: room conflict, out-of-band, and autosave v5.0.2](https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-server-ydoc/jupyter_server_ydoc/rooms.py#L316-L404).
- [S4: docprovider v5.0.2](https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/packages/docprovider/src/yprovider.ts), [handler v2.1.5](https://github.com/jupyterlab/jupyter-collaboration/blob/v2.1.5/jupyter_collaboration/handlers.py#L217-L251).
- [S5: YDoc v4.1.1](https://github.com/jupyter-server/jupyter_ydoc/blob/v4.1.1/jupyter_ydoc/ynotebook.py#L259-L505).
- [S6: shared execution state](https://github.com/jupyter-server/jupyter_ydoc/blob/v4.1.1/javascript/src/ycell.ts#L777-L789).
- [S7: JupyterLab 4.6.3 clearExecution](https://github.com/jupyterlab/jupyterlab/blob/v4.6.3/packages/cells/src/model.ts#L706-L714), [prompt](https://github.com/jupyterlab/jupyterlab/blob/v4.6.3/packages/cells/src/widget.ts#L1680-L1688), [execution and final count](https://github.com/jupyterlab/jupyterlab/blob/v4.6.3/packages/cells/src/widget.ts#L1763-L1823).
- [S8: y-websocket 1.5.4 messageAuth](https://github.com/yjs/y-websocket/blob/v1.5.4/src/y-websocket.js#L23-L96), [upstream lock](https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/yarn.lock#L16158-L16168).
- [S9: Jupyter Server 2.21.0 async rename](https://github.com/jupyter-server/jupyter_server/blob/v2.21.0/jupyter_server/services/contents/filemanager.py#L1103-L1131).
- [S10: MCP 2026-07-28 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
- [S11: MCP 2026-07-28 resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources).
- [S12: MCP 2026-07-28 statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic#statelessness).
- [S13: Collaboration release v5.0.2](https://github.com/jupyterlab/jupyter-collaboration/releases/tag/v5.0.2).
- [S14: YDoc release v4.1.1](https://github.com/jupyter-server/jupyter_ydoc/releases/tag/v4.1.1).
- [S15: Jupyter Server 2.21.0 untitled creation](https://github.com/jupyter-server/jupyter_server/blob/v2.21.0/jupyter_server/services/contents/manager.py#L941-L1038).
- [S16: Meta dependencies](https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-collaboration/pyproject.toml#L32-L36), [server version](https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-server-ydoc/jupyter_server_ydoc/_version.py#L1), [docprovider dependencies](https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/packages/docprovider/package.json#L57-L59).

[S1]: https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-server-ydoc/jupyter_server_ydoc/handlers.py#L247-L331
[S2]: https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-server-ydoc/jupyter_server_ydoc/utils.py#L168-L207
[S3]: https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-server-ydoc/jupyter_server_ydoc/rooms.py#L316-L404
[S4]: https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/packages/docprovider/src/yprovider.ts
[S5]: https://github.com/jupyter-server/jupyter_ydoc/blob/v4.1.1/jupyter_ydoc/ynotebook.py#L259-L505
[S6]: https://github.com/jupyter-server/jupyter_ydoc/blob/v4.1.1/javascript/src/ycell.ts#L777-L789
[S7]: https://github.com/jupyterlab/jupyterlab/blob/v4.6.3/packages/cells/src/widget.ts#L1680-L1688
[S8]: https://github.com/yjs/y-websocket/blob/v1.5.4/src/y-websocket.js#L23-L96
[S9]: https://github.com/jupyter-server/jupyter_server/blob/v2.21.0/jupyter_server/services/contents/filemanager.py#L1103-L1131
[S10]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[S11]: https://modelcontextprotocol.io/specification/2026-07-28/server/resources
[S12]: https://modelcontextprotocol.io/specification/2026-07-28/basic#statelessness
[S13]: https://github.com/jupyterlab/jupyter-collaboration/releases/tag/v5.0.2
[S14]: https://github.com/jupyter-server/jupyter_ydoc/releases/tag/v4.1.1
[S15]: https://github.com/jupyter-server/jupyter_server/blob/v2.21.0/jupyter_server/services/contents/manager.py#L941-L1038
[S16]: https://github.com/jupyterlab/jupyter-collaboration/blob/v5.0.2/projects/jupyter-collaboration/pyproject.toml#L32-L36
