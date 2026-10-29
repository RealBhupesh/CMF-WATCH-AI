# Workflow dispatch recovery: EGM review record

Date: 2026-10-29

## Method and scope

Applied the installed EGM brainstorm/draft and review-loop guidance to one
bounded crawler reliability change. Existing owner instructions delegate routine
choices and omit human review gates. Reviewers used fresh conversation contexts
(`fork_turns: none`), read bundled EGM personas and the implementation-readiness
standard, and inspected the plan plus explicitly supplied workflow source/tests.
No reviewer edited code or performed external website actions.

## Initial design audit

Both codebase-details and implementation-readiness reviewers completed their
reads. They independently found the same Major issue in the proposed fix:
preserving a zero-attempt `verifying` step only during resume was insufficient.
The runner's outer catch overwrote verifying with blocked, erasing its sole
uncertainty evidence. A subsequent continue could dispatch the action.

Resolution: retain verifying status on that step when its workflow blocks, attach
the error, and test two failed continues issuing zero clicks. This is implemented.

Two Nits were also resolved: explicitly cover both maxAttempts=1 and the default
two-attempt budget; limit durability claims to process interruption because the
existing atomic write/rename storage does not use filesystem fsync.

## Implementation

- Shared recovery classification preserves claims, saved outcomes, application
  IDs, and explicit verifying state.
- Unclaimed clicks can make their first attempt after a cleared exception.
- Preflight observation errors do not trigger side-effect outcome recovery.
- Repeatable failures inside per-step preflight save the exhausted retry count.
  The budget is checked before another preflight on continuation.
- No persisted schema, dependency, or MCP argument changes.

## Independent implementation reviews

Round 2 completed all requested reads with no remaining Blocker or Major
findings. Its wording clarification was applied: only failures inside per-step
preflight consume the action retry budget, while context restoration remains
outside that loop.

Round 3 used another fresh context and completed all requested persona,
standard, plan, source, and test reads. It returned no Blocker, Major, or Nit
findings within the defined scope. These are two consecutive rounds with no
unsettled Blocker or Major findings. All requested reviewers completed; none
were counted as clean after failure or timeout.

## Verification

Focused workflow tests passed before the final default-budget parameterization.
The final `npm run check` passed lint, type checking, all 96 tests across 15
files, and the production build. Browser regressions use controlled Chromium
fixtures; they perform no real external submissions or verification challenges.

No interface visuals changed. The supplied design law was checked for applicability:
there are no added layouts, typography, images, colors, icons, motion, or controls
to visually inspect. Documentation and MCP tool descriptions match the new behavior.

## Limits

An action claimed before a process interruption remains uncertain even when it
may never have reached the website. Context/tab restoration errors remain blocked
without consuming per-step retries. Lost form-state restoration and application
audit matching are separate existing concerns, outside this change. Deployment
and a running client's server restart were not performed.
