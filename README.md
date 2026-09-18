# jev-flash-review

Rule-based code review for AI coding agents, powered by [TypeSafe Jev](https://typesafe.ai).
Ship three skills to your agent — review a PR, review anything, or loop until
the rule engine reports clean — backed by one local MCP review engine.

Local-first: the engine never reads your repository. The calling agent supplies
the diff (and the business context); the engine returns structured verdicts.

## How it works

```
agent curates input → review_diff tool → structured JSON → agent acts
```

1. **The agent builds the input**: a unified diff plus `taskContext` — the
   business purpose, boundaries ("fence") and invariants of the task. The diff
   alone judges hygiene; the fence lets the engine judge business-logic fit.
2. **The engine evaluates every rule in `src/rules/`**: the diff is chunked
   into file-sized pieces (no duplication — every file is judged exactly
   once); each rule becomes a typed Choice question (`YES` / `NO` / `N/A`
   with `applies_if`), questions are batched per (chunk × rule set) and run in
   parallel.
3. **Pull pass**: a borderline judgment (probability in the 0.35–0.65 band) is
   re-asked once with the related diff files appended (files it imports or
   that import it, plus its test pair), so coupled rules are re-judged with
   both sides in view — paid only where the first look was uncertain.
4. **Merge**: a rule takes its most severe outcome across chunks (worst wins).
5. **Evidence**: for each violation, a second Choice over the diff's hunk
   markers ("select instead of generate") — the engine picks the location,
   the code prints `file:line`. Violations with no hunk are reported as
   `absence` (missing tests, docs, handling) or PR-level issues.
6. **Adjudication**: weak locations (top confidence < 0.55) are dropped, not
   reported. Survivors pass a confirm Choice ("does this location actually
   show the violation?") — `unsupported` kills them. Confirmed violations get
   an impact rating (`none` / `minor` / `significant` / `critical`) scored
   against the selected evidence.
7. **Output** (JSON): `results` holds the full matrix (every rule, including
   dropped ones); `violations` holds confirmed findings only. Each outcome
   carries answer, probability, confidence, severity, question text, evidence
   locations and impact. Summary: `total / yes / no / n/a / blockers /
   dropped`, plus chunk count and token usage.

## The skills

| Skill | Trigger | Input source |
|---|---|---|
| `review-pr` | Review a GitHub PR by number or URL | `gh pr view` + `gh pr diff` |
| `review-free` | Review anything that is not a PR — files, modules, working-tree changes, diffs against a branch | Agent-curated diff (`git diff`, untracked files, or full files rendered as all-additions diffs) |
| `review-loop` | Iterate while implementing until the engine is clean | Current working diff, re-collected every iteration |

All three call the same `review_diff` MCP tool. If the tool is not available in
the session, the skills stop and tell you how to register the engine — they
never substitute a manual review for the engine's verdict.

## Setup

Requirements: Node.js 24+, a [TypeSafe API key](https://console.typesafe.ai),
and `gh` (authenticated) for the PR skill.

```sh
npm install
echo 'TYPESAFE_API_KEY=...' > .env   # gitignored, inherited by the engine process
npm run bundle                        # builds dist/server.js (gitignored, local only)
```

> Note: `dist/` is intentionally not committed. After cloning, run
> `npm run bundle` once (and again after pulling engine changes) so the MCP
> server the harnesses point at exists and is fresh.

## Installation per harness

### Claude Code

```
/plugin marketplace add lucvalse/jev-flash-review
/plugin install jev-flash-review@jev-flash-review
```

Skills: `jev-flash-review:review-pr`, `jev-flash-review:review-free`,
`jev-flash-review:review-loop`. The bundled `.mcp.json` registers the review
engine automatically.

### Codex (CLI)

```sh
codex plugin marketplace add lucvalse/jev-flash-review
codex plugin add jev-flash-review@jev-flash-review
```

Register the engine manually in `~/.codex/config.toml` (Codex does not read
`.mcp.json`):

```toml
[mcp_servers.jev-flash-review]
command = "node"
args = ["/absolute/path/to/jev-flash-review/dist/server.js"]
env_vars = ["TYPESAFE_API_KEY"]
```

Restart Codex. Codex desktop loads the skills but not MCP servers — full
reviews stay on the CLI.

### Cursor

```
/add-plugin
```

Paste `https://github.com/lucvalse/jev-flash-review` when prompted. Cursor
loads skills from `skills/` and commands from `commands/`, then register the
engine in Cursor's MCP settings pointing at `dist/server.js`.

### OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/jev-flash-review/.opencode/plugins/jev-flash-review.mjs"]
}
```

```sh
opencode mcp add jev-flash-review --global -- node /absolute/path/to/jev-flash-review/dist/server.js
```

The tool appears as `jev-flash-review_review_diff`.

## Remote engine (Cloudflare Worker)

Same engine, same `review_diff` contract, reachable from anywhere without the
Mac on. The Worker is stateless (one MCP instance per request, no sessions) —
the skills work unchanged against it; only the client registration differs.

```sh
npm run deploy   # requires: wrangler login (once per machine)
```

Secrets (set once, never in the repo):

```sh
wrangler secret put TYPESAFE_API_KEY
wrangler secret put REVIEW_BEARER   # any long random string, e.g. openssl rand -hex 32
```

Every request must carry `Authorization: Bearer <REVIEW_BEARER>`.

```sh
# Claude Code
claude mcp add --transport http jev-flash-review https://jev-flash-review.<you>.workers.dev \
  --header "Authorization: Bearer <REVIEW_BEARER>"

# OpenCode — in opencode.json
# "jev-flash-review": { "type": "remote",
#   "url": "https://jev-flash-review.<you>.workers.dev",
#   "headers": { "Authorization": "Bearer <REVIEW_BEARER>" } }
```

Notes: `dist/` stays local-only (see above) — the Worker bundles everything
itself. Start on the free tier; the engine fans out parallel TypeSafe calls,
so upgrade to paid if large reviews feel slow (subrequest concurrency).

## CLI usage

The classic one-shot PR review still works without any agent:

```sh
npm run review -- 123                    # inside a repo checkout
npm run review -- https://github.com/owner/repo/pull/123
```

Prints the text report; exits `1` on `blocker` violations (CI-friendly).

## Rules

`src/rules/` holds the contract (`meta.json`) plus one file per review type
(category). Each rule is a
`{ rule_id, question, applies_if, severity }` — the `question` text is sent to
the model:

```json
{
  "contract": { "rules": ["Compliant: ...", "Violation: ...", "N/A: ..."] },
  "categories": [
    {
      "name": "security",
      "rules": [
        {
          "rule_id": "SEC-31",
          "question": "Are no hardcoded secrets or credentials present in the diff?",
          "applies_if": "The diff adds or moves credential-like literals",
          "severity": "blocker"
        }
      ]
    }
  ]
}
```

## Architecture

```
skills/<name>/SKILL.md     canonical agent workflows (review-pr, review-free, review-loop)
commands/<name>.md          thin command adapters
src/engine.ts               review workflow: chunk, ask, merge (pure domain, no drivers)
src/evidence.ts             evidence location over hunk markers
src/adjudicate.ts           confidence gate, noIssue-style confirm, impact rating
src/judge.ts                TypeSafe adapter implementing the Judge port
src/types.ts                domain contracts (Result, ReviewInput/Output, ChoiceSpec)
src/diff.ts                 chunking + hunk annotation
src/rules.ts                boundary parser, merges src/rules/*.json
src/index.ts                CLI shell (gh + text report)
src/mcp/server.ts           MCP stdio server (thin handler)
dist/server.js              committed bundle — what consumers run, no build needed
```

The domain never imports a concrete driver: the engine takes a `Judge` port,
implemented by `TypeSafeJudge`. Swap the adapter and the workflow is unchanged —
including a future remote transport.

## Scripts

| Command | What it does |
|---|---|
| `npm run review -- <pr>` | One-shot PR review |
| `npm test` | Unit tests + skills portability tests |
| `npm run bundle` | Rebuild `dist/server.js` (run after touching `src/`) |
| `npm run dev` | Watch mode (`tsx watch`) |
| `npm run build` | Compile `src/` → `dist/` (`tsc`) |
| `npm run typecheck` | Type check only |
| `npm run lint` / `lint:fix` | Biome check (write mode for fix) |
| `npm run release` | Conventional release: bump + CHANGELOG + manifests sync + git tag + push |

## Commits and releases

Conventional Commits (commitlint enforced). `npm run release` bumps
`package.json`, syncs the version into every provider manifest
(`scripts/sync-manifests.cjs`, tested by the portability suite), updates
CHANGELOG.md, then commits + tags + pushes. CI runs typecheck and tests on
push and PRs.

## Privacy

The engine process holds `TYPESAFE_API_KEY` in memory and sends it only in the
TLS Authorization header to `https://api.typesafe.ai`. Only the `diff`,
`title`, `description` and `taskContext` you supply per call leave the machine.
Never send secrets, `.env` files, vendored code, or lockfiles.
