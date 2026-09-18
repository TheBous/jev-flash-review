# Changelog

## [0.7.0](https://github.com/TheBous/review-blaster/compare/v0.6.0...v0.7.0) (2026-09-18)

### Features

* add new security and LLM-powered application security rules ([a122daf](https://github.com/TheBous/review-blaster/commit/a122dafa3b0f0e597c4686e570eac0e0d1a2dc10))
* add security rule to ensure input validation integrity ([44bbfbb](https://github.com/TheBous/review-blaster/commit/44bbfbbbbcad2aa6c697671f4d487b3bef805f19))
* **rules:** add agent-native capability parity and privacy compliance rules ([e4d9a00](https://github.com/TheBous/review-blaster/commit/e4d9a004aabe1cb1d17c88d637a6f808bcdbcd02))
* **rules:** add frontend engineering rules and update meta references ([658a7bd](https://github.com/TheBous/review-blaster/commit/658a7bd52e30292daa21ca3941179429634371eb))
* **rules:** enhance guidance for handling large reviews and PRs with coherent grouping ([0a3dda0](https://github.com/TheBous/review-blaster/commit/0a3dda015a7dcf18475ba97fb53da2df5914bd5a))
* **rules:** lower severity of ARC-10 rule from high to low ([1a359f2](https://github.com/TheBous/review-blaster/commit/1a359f290b34a2bb8c0d7ca098bfb5244aab1fac))
* **rules:** split in more files ([0529a32](https://github.com/TheBous/review-blaster/commit/0529a321e8906850c0382b849b8f68d92f00893d))

## [0.6.0](https://github.com/TheBous/review-blaster/compare/v0.5.0...v0.6.0) (2026-09-18)

### Features

* enhance adjudication process with evidence snippets and improve confirmation logic ([cbdb5ae](https://github.com/TheBous/review-blaster/commit/cbdb5aeb4564948db3eb226c820f3914ae00b7e4))

## [0.5.0](https://github.com/TheBous/review-blaster/compare/v0.4.0...v0.5.0) (2026-09-18)

### Features

* refactor MCP server to use a dedicated review server and add worker support ([cc5d66c](https://github.com/TheBous/review-blaster/commit/cc5d66c76aba44ad9fe3e5fab04d1d13067dcea2))

## [0.4.0](https://github.com/TheBous/review-blaster/compare/v0.3.0...v0.4.0) (2026-09-18)

### Features

* enhance adjudication process and reporting for violations ([4f7b5b9](https://github.com/TheBous/review-blaster/commit/4f7b5b9bdf717951629d62326957241db5509aaf))
* update README to enhance clarity on functionality and usage of jev-flash-review ([f73bec5](https://github.com/TheBous/review-blaster/commit/f73bec546c88eac6800efb9d13e7ec6d9799ffa6))

## [0.3.0](https://github.com/TheBous/review-blaster/compare/v0.2.0...v0.3.0) (2026-09-18)

### Features

* implement frontmatter parsing and update MCP server version to 0.2.0 ([1f45f69](https://github.com/TheBous/review-blaster/commit/1f45f69664ebf2abac6df750a31e3e264d103c23))

## 0.2.0 (2026-09-18)

### Features

* add @typesafe-ai/sdk as a dependency ([7997dee](https://github.com/TheBous/review-blaster/commit/7997dee00f4102874f1a632724830c8d26b42e00))
* add GitHub Actions workflow for testing and implement sync script for manifest versions ([33ebd24](https://github.com/TheBous/review-blaster/commit/33ebd24d9a340c938d787e74ba0780e184a4fcfa))
* add initial plugin and skill implementations for review-blaster ([e86c48a](https://github.com/TheBous/review-blaster/commit/e86c48a4f52bc005cf6d7d2aa539aa96d91e1772))
* add TypeSafe PR review runner with rules, pass/fail checks, and severity categorization ([9f3e265](https://github.com/TheBous/review-blaster/commit/9f3e26569705711bbe921d91e5e4d8b88cc2377a))
* chunk large diffs across parallel TypeSafe calls to stay within the request token budget ([3480567](https://github.com/TheBous/review-blaster/commit/34805673a55cacc83fbafe5c298a5cb91df777ba))
* enhance evidence handling with hunk-aware annotation and improved reporting ([5b29460](https://github.com/TheBous/review-blaster/commit/5b294608aee967c53a007ce75e50717c8ae52c3b))
* enhance review process with task context for business logic evaluation ([4698bf7](https://github.com/TheBous/review-blaster/commit/4698bf790824dee854fbff575fa3209c82bb0f3b))
* first commit ([78e1867](https://github.com/TheBous/review-blaster/commit/78e1867c2c6e016ef968bdbfc17ac2c4df93c01c))
* implement rule parsing and validation, integrate TypeSafe judge for review process ([a862baa](https://github.com/TheBous/review-blaster/commit/a862baa8207c1258e07f9ab3d488fcc5bed9b556))
* integrate Model Context Protocol SDK and refactor review engine ([ee0270d](https://github.com/TheBous/review-blaster/commit/ee0270dd48afdab3c1c3b8af8128a408b54644d0))
* rename project from review-blaster to jev-flash-review and update related configurations ([16b7caf](https://github.com/TheBous/review-blaster/commit/16b7caf39189d9e97b11e9732e72c3c53980cbc0))
* rules EN ([e7e3757](https://github.com/TheBous/review-blaster/commit/e7e3757b68e2990a26e112d431b84432d60dfeb9))
* **rules:** add all rules ([9a98090](https://github.com/TheBous/review-blaster/commit/9a98090602a9ec04fc9ca17a1364d3894c8f6002))
* **rules:** add review rules ([7c6d6cc](https://github.com/TheBous/review-blaster/commit/7c6d6cc85cbe820c1df93f589a2273996db4b9fa))
* **rules:** refactor rule structure and enhance batch processing for TypeSafe calls ([d195c6c](https://github.com/TheBous/review-blaster/commit/d195c6c7c5152b85eae6af2fae921e1abb903a92))
* warn when diff exceeds TypeSafe request budget and gets truncated ([fc4bbef](https://github.com/TheBous/review-blaster/commit/fc4bbefe42416f2388163e968f7d32cfde5cc842))
