# jev-flash-review

AI-powered PR review runner (Node 24 + TypeScript, ESM). Checks a GitHub pull
request against the rules in `rules.json` using [TypeSafe](https://typesafe.ai)'s
System One model (Jev), then categorizes every violation as **must fix**,
**recommended**, or **minor**.

## How it works

1. Fetches PR title, description, and full diff via `gh` (must be installed and authenticated)
2. One batched TypeSafe call: one **Noul** (yes/no) question per rule → binary pass/fail (pass ≥ 0.5)
3. One batched TypeSafe call for the failed rules only: **Choice** question each → `must_fix` / `recommended` / `minor`
4. Prints the report; exits `1` if any violation is `must_fix` (CI-friendly)

## Setup

```sh
npm install
echo 'TYPESAFE_API_KEY=...' > .env   # from console.typesafe.ai (.env is gitignored)
```

## Usage

```sh
npm run review -- 123                    # inside a repo checkout
npm run review -- https://github.com/owner/repo/pull/123
```

## Rules

`rules.json` is an array of `{ "id", "check" }`. The `check` text is sent to the
model verbatim — write it as a clear condition the PR must satisfy:

```json
[
  { "id": "no_secrets", "check": "The diff contains no API keys, tokens, or credentials." }
]
```

## Boilerplate scripts

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm run review`    | Run the PR review (see above)                       |
| `npm run dev`       | Watch mode (`tsx watch`)                            |
| `npm run build`     | Compile `src/` → `dist/` (`tsc`)                    |
| `npm start`         | Run compiled CLI from `dist/`                       |
| `npm run lint`      | Lint + format check (`biome check .`)               |
| `npm run lint:fix`  | Lint + format + organize imports (write mode)       |
| `npm run typecheck` | Type check only                                     |
| `npm run release`   | Conventional release: bump + CHANGELOG + git tag + push |

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org) —
enforced by commitlint on `commit-msg`. Format: `type(scope): message`
(e.g. `feat(api): add review endpoint`).

On `pre-commit`, lint-staged runs Biome (lint + format) on staged files.
Fixable issues are fixed and re-staged; unfixable ones block the commit.

## Release

```sh
npm run release            # interactive patch/minor/major picker
npm run release -- minor   # direct bump
npm run release -- --dry-run
```

Bumps are derived from commits (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major),
CHANGELOG.md is updated, then commit + tag `vX.Y.Z` + push.
# jev-flash-review
