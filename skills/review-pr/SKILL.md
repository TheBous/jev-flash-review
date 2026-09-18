---
name: review-pr
description: >
  Use when the user asks to review a GitHub pull request by number or URL, or
  wants a rule-compliance check on a PR before merging.
---

# Review a PR

Run the project rule engine over a GitHub pull request via the `review_diff`
tool of the `review-blaster` MCP server.

**Core principle: the engine never reads the repository — you supply the diff,
it returns verdicts.**

## Steps

1. Collect the input (both via `gh`):

   ```bash
   gh pr view <ref> --json title,body
   gh pr diff <ref>
   ```

2. Call `review_diff` with:
   - `diff`: the full `gh pr diff` output
   - `title` / `description`: from the PR metadata
   - `taskContext`: the business context of the change — what the feature/fix
     is for, its boundaries and invariants. Take it from the user's request and
     from any context they state; the PR body alone rarely carries the fence.

3. Report to the user, in this order:
   - One-line verdict: clean, or N violations of which M blockers.
   - Blockers, then high/medium/low: for each violation
     `[rule_id] question` plus its evidence locations (`file:line`).
   - Summary counts (`total / yes / no / n/a`) and token usage.

## Common mistakes

- Truncating the diff to fit — review in coherent slices instead (one feature
  or file group per call) and merge results.
- Presenting a `NO` as a certainty — report it as a finding with its
  probability and let the user decide.
- Detailing `N/A` rules — one line with their ids, nothing more.
- Burying the verdict under rule-by-rule narration — verdict first, always.
