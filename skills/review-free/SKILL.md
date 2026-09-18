---
name: review-free
description: >
  Use when the user asks to check code that is not a GitHub PR — named files
  or modules, uncommitted working-tree changes, or a diff against a branch.
---

# Review anything

The `review_diff` tool of the `jev-flash-review` MCP server accepts any unified
diff.

**Core principle: you curate, the engine judges.** Read what the user asked
about, build the diff yourself, send only what is needed — the engine reads
nothing on its own.

## If the engine is missing

If the `review_diff` MCP tool is not in your available tools: STOP. Tell the user
the review engine MCP is not registered in this session and give them the
registration line for their harness. Do NOT substitute a manual diff analysis,
and never present one as the engine's result.

## Building the diff

Pick the first case that matches:

- **Uncommitted work**: `git diff HEAD`, plus each untracked file
  (`git ls-files --others --exclude-standard`) rendered as an all-additions
  diff.
- **Changes on a branch**: `git diff <base>...HEAD -- <paths the user asked about>`.
- **Files the user named, no git change to show**: render their full content as
  all-additions diffs:

  ```
  --- a/<path>
  +++ b/<path>
  @@ -0,0 +1,N @@
  +<line>
  ```

## Steps

1. Build the diff per above; set `title` to a one-line summary of what is being
   reviewed and `description` to the user's request. Put the business context
   in `taskContext`: purpose of the change, its boundaries (what is in and out
   of scope), invariants it must respect. This is what lets the engine judge
   business-logic fit, not just diff-level hygiene.
2. Call `review_diff`.
3. Report: verdict first, then blockers with evidence locations, then other
   violations by severity, then summary counts. `N/A` rules in one line.

## Common mistakes

- Sending secrets, `.env` files, vendored code, or lockfiles — never.
- Sending whole-file dumps when the user asked about a module — diff the
  module's files, not the world.
- Splitting a huge target by character count — split by coherent slices (per
  module) and merge results.
- Treating a `NO` as a verdict — it is a finding with a probability.
