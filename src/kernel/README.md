# src/kernel

Kernel message routing, a pure output reducer, and a job queue (SPEC.md §4,
§8). The module knows nothing about Yjs or MCP: output is sent through the
`OutputSink` seam from `src/core`, and connection settings are supplied from
outside.

## Layers

| File | Purpose |
| --- | --- |
| `messages.ts` | Structural representation of the Jupyter protocol (`JupyterMessage`) and parsing of `content`. The only place where an `@jupyterlab/services` message is converted to our type (`fromKernelMessage`). |
| `display-registry.ts` | `DisplayRegistry`, a `display_id → targets` table with one instance per kernel; it outlives any execution and spans multiple cells. |
| `output-reducer.ts` | `createExecutionReducer()`, a pure function that converts protocol messages into `OutputSink` commands. |
| `kernel-client.ts` | `KernelClient`, one WebSocket connection and **one** message receiver per instance. There is no deduplication by `(server, kernel_id)` here: the binding owner maintains one instance per kernel. |
| `job-record.ts` | Mutable job record and its conversion to `src/core` contracts. |
| `execution-registry.ts` | `ExecutionRegistry`: sequential jobs, target revalidation, and the distinction between `not_sent` and `unknown`. |

## API

- `createExecutionReducer({area, msgId, displays, maxOutputBytes?})` →
  `{feed(msg): ReducerEffect[], state}`. Effects mirror `OutputSink` methods:
  `append`, `update`, `replace`, `clear`, `setCount`, `setState`, `complete`.
  Rules: consecutive `stream` outputs with the same `name` are merged;
  `clear_output(wait=false)` clears immediately, while `wait=true` clears with
  the next output (as one `replace`); `update_display_data` updates all
  registered targets, including those in other cells and executions;
  `transient.display_id` is not persisted; an `error` is recorded exactly once
  (`execute_reply` does not duplicate it); completion requires both
  `execute_reply` and IOPub `idle`, in either order; `execution_count` is taken
  from `execute_input` but published only on completion together with
  `execution_state: idle`—publishing it early clears `[*]` in JupyterLab 4.6.3;
  when the byte budget is exceeded, `outputIncomplete` is set and output
  collection stops, but completion tracking continues.
- `new KernelClient({serverSettings, kernelId, kernelName?})`:
  `kernelStatus()` → `{channel, execution, observedAt}`;
  `registerExecution(msgId, route)`; `requestExecute(code, {cellId, route?})`
  (`allow_stdin: false`, `stop_on_error: true`, metadata `{cellId}`);
  `onKernelChanged` / `onStatusChanged`; `interrupt()`, `restart()`,
  `shutdown()`, `dispose()`; the `displays` field is this kernel's
  `DisplayRegistry`. Messages without a registered `parent_header.msg_id`
  update only observed status: foreign `busy` messages count, while foreign
  outputs are not written. Routes are additive: the same `msg_id` may be
  subscribed to multiple times (the registry keeps its route open after
  `idle`, and an observer does not displace it), and the returned handle
  removes only its own subscription.
- `new ExecutionRegistry(kernelClient)`: `submit({notebookRef, cells, getSink,
  revalidate, stopOnError?, maxOutputBytes?})` → `execution_id`;
  `get(id)`, `cancel(id)`, `waitForChange(id, sinceCursor, waitMs)`, `dispose()`.
  The cursor is a monotonic counter of job-record changes.

## Module guarantees

- Cells are sent sequentially: the next cell follows the previous cell's
  `reply` + `idle` and target revalidation. Jobs on the same kernel are also
  queued.
- `revalidate` is called before sending. A mismatch stops the queue before the
  send; the cell receives `not_sent` with a reason and the job becomes
  `failed`.
- `getSink` opens a new output-area generation; writes continue only while
  `sink.isCurrent()`. Otherwise the result remains in the job and
  `outputAreaLost` is set, both for its own area and for an undelivered
  `update_display_data` targeting a foreign area from a stale generation.
- An execution route outlives the execution itself: late output from a
  background thread after `idle` continues to be written to the same area and
  job record while the area remains ours. The route is removed when the area
  is no longer ours, on a kernel lifecycle event, on `dispose()`, or after
  `LATE_ROUTE_LIMIT` newly completed executions.
- Open output areas remain reachable while `isCurrent()`: a cross-cell
  `update_display_data` finds the area from an earlier execution and updates
  both the shared model and the owning job's `outputsCollected`.
- `kernel_changed` (including disposal of the `KernelClient` itself) makes
  sent work `unknown` and unsent work `not_sent`/`kernel_changed`. Any channel
  state other than `connected` is treated as loss of evidence:
  `@jupyterlab/services` reports a broken socket as `connecting` and reaches
  `disconnected` only after seven attempts. Code is never resent.
- A request known not to have reached the socket (`requestExecute` threw) is
  `not_sent`/`kernel_dead`, not `unknown`.
- An exception from `revalidate`/`getSink` does not escape as an unhandled
  rejection: the job receives a terminal state and `reason`, and the kernel
  queue continues operating.
- `cancel` removes only unsent cells; `dispose()` moves both in-flight work
  (`unknown`) and everything queued (`not_sent`/`cancelled`) to terminal states.

## Not provided here

- No kernel-to-notebook binding: Sessions API, `kernel_control`, kernelspec
  selection, and `KERNEL_NOT_BOUND` are outside this module.
- No writes to the shared model: the notebook model (`src/core/notebook`)
  implements `OutputSink` and `BeginExecutionGeneration`.
- No `console.*` interception (the pitfall from spike §3.4): `src/jupyter`
  performs it before any `KernelConnection` is created; tests install their
  own interception.
- No server-side execution (`POST /api/kernels/{id}/execute`): that requires a
  separate adapter after the first version (SPEC.md §8).
- No `comm`/widgets/debugger or interactive stdin: `comm_*` messages are
  ignored without disrupting the stream, and `input()` terminates with a
  kernel error.
- No job reconnection: a channel break terminates the cell as `unknown`;
  restoring the connection neither proves the result nor resumes the job.
- No `KernelClient` pool: instances are not deduplicated by
  `(server, kernel_id)`; the binding owner provides one instance per kernel.
- No `request_id` deduplication, MCP response limits, or `output_read`: those
  belong to the `src/mcp` layer.

## Tests

```sh
pnpm vitest run test/kernel --project unit   # 54 tests, no server
pnpm vitest run test/kernel --project int    # 16 tests, port 8889, python3
```

`review.*.test.ts` is the adversarial-review regression suite: late output,
throwing callbacks, channel breaks followed by recovery, `dispose()` with a
queue, cross-cell display updates, stream-merging cost, and routing messages
without `parent_header`.

The integration tests start and stop the `dev/jupyter` environment themselves.
