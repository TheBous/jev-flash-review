---
name: review-pr
description: >
  Use when the user asks to review a GitHub pull request by number or URL, or
  wants a rule-compliance check on a PR before merging.
---

# Review a PR

Run the project rule engine over a GitHub pull request via the `review_diff`
tool of the `jev-flash-review` MCP server.

**Core principle: the engine never reads the repository — you supply the diff,
it returns verdicts.**

## If the engine is missing

If the `review_diff` MCP tool is not in your available tools: STOP. Tell the user
the review engine MCP is not registered in this session and give them the
registration line for their harness. Do NOT substitute a manual diff analysis,
and never present one as the engine's result.

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
     `[rule_id] question` plus its evidence locations (`file:line`) and impact.
   - Summary counts (`total / yes / no / n/a / dropped`) and token usage.

   Read findings from the `violations` array — it holds only confirmed
   findings. `results` is the full matrix including dropped ones; never report
   dropped rules as violations.

## Large PRs: group related files

Default: one `review_diff` call with the whole diff. The engine keeps
import-related files and test/source pairs inside the same analysis chunk and
splits under budget on its own.

Step in only when you can see relations the engine cannot: path aliases
(`@/...`), barrel re-exports, cross-package features, or structure you know
from reading the codebase. Then:

1. Partition the diff into coherent groups — coupled files together,
   unrelated files apart.
2. Make one `review_diff` call per group, keeping `title`, `description`, and
   `taskContext` identical across calls.
3. Merge the verdicts when reporting: concatenate the `violations` arrays and
   sum the summary counts.

Never split coupled files across groups — a rule that checks the contract
between two files needs both sides in the same call.

## Common mistakes

- Truncating the diff to fit — split into coherent file groups (see Large PRs
  above) and make one call per group.
- Presenting a `NO` as a certainty — report it as a finding with its
  probability and let the user decide.
- Detailing `N/A` rules — one line with their ids, nothing more.
- Burying the verdict under rule-by-rule narration — verdict first, always.
