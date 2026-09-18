import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TypeSafeJudge } from '../judge.js';
import { loadRules } from '../rules.js';
import { createReviewServer } from './reviewServer.js';

const rules = await loadRules();
if (!rules.ok) {
  // Broken boot configuration is an invariant violation: refuse to start.
  console.error(`Cannot load rules: ${rules.error}`);
  process.exit(1);
}

const server = createReviewServer(rules.value, new TypeSafeJudge());
await server.connect(new StdioServerTransport());
