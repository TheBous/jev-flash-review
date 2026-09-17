# review-blaster

Node 24 + TypeScript server boilerplate (ESM).

## Scripts

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm run dev`       | Dev server with watch + reload (`tsx watch`)        |
| `npm run build`     | Compile `src/` → `dist/` (`tsc`)                    |
| `npm start`         | Run compiled server from `dist/`                    |
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
# review-blaster
