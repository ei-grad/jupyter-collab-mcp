# Review policy

This policy complements `AGENTS.md`. Review the behavior and risks of the
candidate, using `SPEC.md` as the product contract.

## Merge criterion

A useful PR that satisfies all applicable mandatory checks below and has no
unresolved material finding should be merged under the repository's existing
authorization and integration rules. Optional polish, reviewer preferences,
unrelated refactoring, and speculative additional review layers must not delay
that result.

Apply checks in proportion to the changed behavior and its dependencies. Mark
irrelevant checks as not applicable with a short reason; do not manufacture
work to satisfy a checklist. Record pre-existing, unaffected problems separately
instead of silently expanding the PR. A failing required check or an unmet
contract in the changed scope is not optional polish.

## Evidence and findings

- State the affected invariant, trigger, observable consequence, affected code,
  and reproduction or direct code evidence. Separate confirmed defects, test
  defects, documentation mismatches, and unverified residual risks. Do not infer
  a cause merely from a failing integration test.
- Use **blocker** for a demonstrated condition that makes the intended release
  unsafe or unusable; **high** for serious security, corruption, execution, or
  availability failures; **medium** for concrete contract violations with
  bounded impact; **low** for non-material maintenance or clarity issues.
  A material finding requires a fix or evidence that the claimed defect does
  not apply. Record severity and deployment assumptions explicitly.
- Maintain one findings ledger with evidence, affected invariant/files, focused
  closure check, and disposition. Separate optional suggestions from findings.
- After reproducing a defect, follow `AGENTS.md`: add the smallest missing
  normative invariant to `SPEC.md` and a regression test. Exercise the real
  integration fixture when the defect crosses an external boundary.

## Mandatory checks

### Correctness, identity, and concurrency

- Trace acceptance, side effects, completion, uncertainty, and replay. Existing
  request receipts must be resolved before rechecking mutable preconditions;
  an exact retry must not repeat effects or fail because its first call changed
  state. Check conflicting payloads and capacity-boundary retries.
- Follow cell identity and execution ownership across asynchronous waits,
  deletion/recreation, ID reuse, reconnect, and kernel replacement. A reused ID
  or numeric generation must not authorize stale execution or output writes.
- Check queued work immediately before sending. Verify cancellation, failure,
  restart, and late output preserve the documented state transitions and do not
  attribute another execution's output to the current one.
- Trace pagination through the final MCP response. Truncation must preserve
  access to omitted items without skips or duplicates; output cursors must
  account for updates and clears of already delivered entries. Check final
  serialized size, including metadata overhead and a single oversized field.
  Continuation boundaries must preserve complete encoding units; an indivisible
  unit must produce an explicit error without advancing the cursor.

### Security and lifecycle

- Trace credentials through configuration, discovery, HTTP/WebSocket requests,
  redirects, failures, logs, descriptors, and MCP results. Use synthetic secrets
  to check reflected errors and credential-bearing URLs. Verify configured
  origin boundaries and authenticated identity claims used for authorization.
  Outbound identity-provider requests must not downgrade or follow redirects.
  Distinguish invalid credentials from inconclusive verification infrastructure;
  a temporary verifier failure must not irreversibly mutate a valid grant.
- For HTTP mode, verify principal/credential-generation isolation, handle and
  resource ownership, expiry, worker capacity, and subprocess credential custody.
- For browser flows, verify advertised methods, headers, and CORS preflights
  agree across both OAuth and MCP endpoints, including authenticated successes
  and failures. Consume codes and state atomically, bind their lifetime to
  the verified upstream grant, and reapply current redirect policy before a
  persisted registration or pre-callback transaction can cause a redirect.
- Check close/shutdown during pending work, rejected promises, listener/timer
  cleanup, and pool invalidation/reacquisition. Late completion must not revive
  a closed owner; releasing an old lease must not remove its replacement.
  Verify dependency-created background work where lifecycle methods affect it.
  Cleanup must continue after an independent resource fails and preserve enough
  ownership information for safe retry or diagnosis. A partially closed object
  must remain quarantined until cleanup succeeds and must never be leased again.

### Contracts and design

- Compare changed behavior with public schemas/types/exports, `SPEC.md`, usage
  documentation, and `skill/SKILL.md`. Recovery instructions must work against
  actual handle reuse and lifetime rules. Report persistence and uncertain
  outcomes honestly across service and MCP boundaries.
- Preserve opaque metadata, attachments, and arbitrary user values byte for
  byte unless the public contract explicitly identifies the value as a
  transformable output field.
- Inspect duplication and code clones in changed and adjacent paths, especially
  identity/key construction, validation, routing, and error conversion. Check
  cohesion of ownership and cleanup, and coupling across notebook, transport,
  kernel, service, MCP, and HTTP-host layers.
- Use SOLID principles as diagnostic questions about concrete change hazards,
  substitutability, responsibilities, and dependencies. Cite an observable risk
  before requiring abstraction or refactoring; similarity or a principle's name
  alone is not a finding. Prefer the smallest coherent correction.

### Tests and release surface

- Each added or retained test in the reviewed scope must protect a product
  invariant, external compatibility boundary, or necessary performance/resource
  constraint. Review the whole portfolio during a full-project audit.
- Remove one-time migration checks, obsolete diagnostic controls, tautological
  tests, and review residue. Prefer observable behavior over exact prose,
  incidental configuration formatting, or dependency-private field layouts.
  Preserve distinct race orderings and real-boundary regressions even when
  nearby unit tests look similar.
- Treat expected failures and skips as explicit coverage limitations. A green
  runner does not close their unmet requirements. Fix defective fixtures or
  assertions using outcome evidence; do not weaken tests merely to obtain green.
- When external fixtures may run simultaneously, verify that each instance owns
  independent runtime and persistence state; distinct ports alone do not prove
  isolation when dependencies resolve storage from a shared working directory.
- Run relevant type/build/tests and required integration checks. For affected
  packaging or release paths, verify clean installation with the declared
  package manager, production dependencies, exported API/CLI, tarball contents,
  and documented container targets. Build contexts must include required build
  configuration. Treat package-manager normalization warnings as defects and
  invoke the packed artifact through its installed bin symlink. Running the
  target file directly is insufficient. Report exactly what ran and what
  remains unverified.

## Convergence and policy maintenance

- Use one reviewer owner and one integrated candidate. Follow the Autonomous
  Review Budget in `AGENTS.md`: normally one full review and at most two targeted
  remediation passes per materially stable candidate, as guidance rather than
  an independent integration gate.
- Closure reviews cover recorded reproductions, changed hunks, and directly
  affected tests, including their identity/security/design implications. Repeat
  broader review only for changed semantics, assumptions, failed evidence, or
  newly demonstrated material risk. A patch-equivalent rebase needs no new full
  review. Do not reset the budget by changing reviewer or commit SHA.
- Once mandatory checks pass and material findings close, issue the merge
  verdict. Do not invent further gates. If an approach repeatedly fails, isolate
  the failure class and reduce verification cost under `AGENTS.md` before
  repeating an expensive cycle.
- When a PR demonstrates a genuinely new problem class, add the smallest
  reusable, evidence-based check to this file. Extend an existing check when it
  already covers the class. Keep incident narration and implementation-specific
  recipes out of this policy; do not add wording-lock tests for its text.
