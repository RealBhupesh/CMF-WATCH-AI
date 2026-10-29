# Workflow recovery before action dispatch

Date: 2026-10-29
Status: Implemented and verified; independent EGM review completed

## Problem and scope

The background workflow runner must resume a cleared exception without repeating
an action that may already have reached a website. Before this change, `resume` changed
every blocked non-repeatable step to `verifying`, even if website verification
blocked the step before its attempt counter increased. A click that never ran
could therefore remain blocked forever. The generic inner catch also started
outcome verification for click/application errors raised before dispatch.

The owner has authorized autonomous implementation and delegated routine design
choices. EGM reviewers inspect this plan in fresh contexts; routine human
approval gates are omitted under that existing instruction.

## Invariants

- Each non-repeatable step is claimed durably before calling its executor.
- A blocked/failed/running non-repeatable step with zero attempts and no saved
  result or application ID has no dispatch claim. Resume may return it to pending.
- A non-repeatable step with a positive attempt count, saved result, application
  ID, or an explicit verifying status remains observation-only on resume.
- A process interruption after the claim and before the website action remains uncertain.
  No action is retried merely because a timeout or missing result suggests it
  probably did not happen.
- Completed steps and attempt counts survive resume. Stopped workflows never
  restart until explicitly continued. No CAPTCHA bypass or new approval step.
- Repeatable failures during per-step preflight inside the action loop consume
  the bounded retry budget and the exhausted count is persisted, including when
  maxAttempts is one. Context/tab restoration happens before this loop; its
  failures remain blocked execution_error without spending an action attempt.

## Alternatives considered

Adding a new dispatch state field would require legacy migration without
providing stronger evidence than the existing durable attempt claim. Repeating
every blocked action would risk duplicate external effects. Treating all blocked
actions as uncertain is today's behavior and strands unattempted steps.

## Implementation phases

1. Modify `src/workflows/model.ts`: export a shared `recoveryStatus(step)` helper
   returning pending for repeatable steps or unclaimed non-repeatable steps, and
   verifying for claimed/explicitly verifying non-repeatable steps. Use existing
   fields; change no JSON schema or MCP arguments.
2. Modify `src/workflows/runner.ts`: use that helper for blocked, failed, running,
   or verifying steps on resume. Only enter click/application outcome recovery
   in the inner catch if the current iteration actually claimed the action.
   For unattempted non-repeatable generic failures, block with execution_error
   and keep attempts zero. Persist computed repeatable failure counts before
   retry or retry_exhausted. Preserve stopped state through existing change guard.
   Check an exhausted attempt budget before preflight so continuing cannot spend
   another preflight attempt after exhaustion.
   When the outer catch blocks a workflow, retain an explicitly verifying step's
   verifying status and attach its error; otherwise a later continue could erase
   the only evidence of a legacy zero-attempt uncertain action.
3. Modify `src/workflows/store.ts`: use the same helper for interrupted running
   steps at startup. Existing uncertain records remain conservative. Blocked and
   stopped workflows retain their existing startup behavior.
4. Modify `src/tools/workflow-tools.ts` and `README.md`: describe that continuing
   a cleared pre-dispatch exception allows an unattempted action, while claimed
   actions remain observation-only. Document conservative crash behavior.
5. Modify `tests/workflows.test.ts` and `tests/workflows.integration.test.ts`:
   cover zero-attempt versus claimed interrupted recovery, preserve explicit
   verifying status and saved evidence, CAPTCHA before a click then cleared
   fixture and continue (one actual click), a preflight condition-check error
   with no click and successful continuation, and preflight repeatable failure
   counts surviving resume. Retain existing uncertain-click/restart/stop tests.
   Include an explicit verifying step with zero attempts: two failed continues
   must preserve verifying and issue zero clicks.
   Require preflight exhaustion regressions with maxAttempts=1 and the default
   two-attempt budget, asserting saved counts and no execution after continue.
6. Run focused workflow tests and then `npm run check`. Review actual changes
   against these invariants and record reviewer findings and verification in
   `docs/designs/workflow-dispatch-recovery-review.md`.

## Compatibility and limitations

No dependencies, schema migration, hosting changes, or tool removals. Existing
positive claims remain uncertain even if they were recorded before an actual
website request. Restoring lost form state and repairing selectors are separate
problems. The retry fix does not claim that repeatable page operations are
transactional. Rollback can use prior code with the same persisted schema.
Process-restart recovery uses the existing atomic write/rename storage; it does
not establish machine-crash or power-loss durability (no filesystem fsync).
