import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadRules, reviewDiff } from '../engine.js';

const config = await loadRules();

const server = new McpServer({ name: 'review-blaster', version: '0.1.0' });

server.registerTool(
  'review_diff',
  {
    description:
      'Review a unified diff against the project rule set. Pure engine: never reads the ' +
      'repository — the caller supplies the diff and optional PR context. Returns structured ' +
      'JSON: one outcome per rule (answer YES/NO/N/A, probability, confidence, severity, ' +
      'evidence locations) plus summary and token usage. Check `summary.blockers` to decide ' +
      'whether fixes are required.',
    inputSchema: {
      diff: z
        .string()
        .describe('The unified diff to review (e.g. `gh pr diff`, `git diff HEAD` output)'),
      title: z.string().optional().describe('Title of the change under review'),
      description: z.string().optional().describe('Description of the change under review'),
    },
  },
  async ({ diff, title, description }) => {
    const output = await reviewDiff({ diff, title, description }, config);
    return { content: [{ type: 'text', text: JSON.stringify(output) }] };
  },
);

await server.connect(new StdioServerTransport());
