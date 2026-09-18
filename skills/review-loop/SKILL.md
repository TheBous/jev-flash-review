---
name: review-loop
description: >
  Use when implementing a nontrivial change and the project's rule engine
  should gate it, when the user asks to iterate until the code passes the
  project rules, or when a review_diff result still shows blockers.
---

# Review loop

Close the loop: implement → review → fix → re-review, using the `review_diff`
tool of the `jev-flash-review` MCP server as the judge.

**Core principle: the engine is the judge. Your own inspection never
substitutes for its verdict.** A rule you believe you fixed is not fixed until
a re-run reports it clean.

## If the engine is missing

If the `review_diff` MCP tool is not in your available tools: STOP. Tell the user
the review engine MCP is not registered in this session and give them the
registration line for their harness. Do NOT substitute a manual diff analysis,
and never present one as the engine's result.

## The loop

1. Collect the current state: `git diff HEAD`, plus each untracked file
   (`git ls-files --others --exclude-standard`) rendered as an all-additions
   diff. Always review the **current** state, never a stale diff.
2. Call `review_diff` with `title` = a stable one-line task summary,
   `description` = a summary of the change, and `taskContext` = the user's
   requirements plus the feature fence: business rules, boundaries, invariants
   the change must respect. Keep all three identical across iterations so
   results are comparable.
3. If `summary.blockers === 0` and no new `high` violations appeared: stop, go
   to the final report. Count only the `violations` array — confirmed findings.
   Dropped rules (weak or unsupported evidence) are not blockers.
4. Fix, then loop:
   - Address `NO` rules in blocker → high → medium order, using each rule's
     `question` and `evidence` locations to find the code.
   - Make the smallest justified fix. If a rule seems wrong for this change,
     say so to the user in the final report — but still re-run once to confirm
     the engine's position before arguing with it.
   - Re-run the relevant validation (typecheck, tests), then go to step 1.

## Stopping

Stop only when one of these holds:

- A re-run reports zero blockers and no high-severity regression.
- Two consecutive re-runs produce identical results.
- Fixing a violation would change behavior the user did not ask for.

Then report: iterations run, rules that went `NO → YES`, rules still `NO` with
severity and why they were left, final summary counts.

## Rationalizations — all false

| Excuse | Reality |
|---|---|
| "One-line change, I verified it by inspection" | Inspection finds what you expect. The re-run is cheap; a wrong "fixed" is expensive. |
| "Re-running costs tokens/time" | One re-run per fix is the cost of the verdict. Skipping it voids the whole loop. |
| "The next review run will confirm it" | There is no next run you control. Unverified clean claims are guesses. |
| "The rule is wrong for this change, I'll explain instead" | Explain in the final report — after a re-run confirms the engine still flags it. |
| "The tool might re-flag it anyway, so why bother" | That outcome is information (rule needs tuning), not a reason to skip. |

## Red flags — STOP

- About to report success without a clean re-run
- "By inspection", "obviously fine now", "no need to re-check"
- Counting your own judgment of the diff as the loop's final state

## Common mistakes

- Sending a stale diff instead of the current state
- Changing `title`/`description` between iterations, making results
  incomparable
- Fixing rules in random order instead of blocker → high → medium
- Adding speculative code, comments, or tests just to flip an answer
