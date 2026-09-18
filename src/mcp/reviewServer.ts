// Shared MCP surface: registers review_diff on a fresh server. Both transports
// (local stdio, remote Worker) use this factory — same tool, same contract.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { reviewDiff } from '../engine.js';
import type { Judge, RuleConfig } from '../types.js';

export function createReviewServer(rules: RuleConfig, judge: Judge): McpServer {
  const server = new McpServer({ name: 'jev-flash-review', version: '0.9.0' });

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
        taskContext: z
          .string()
          .optional()
          .describe(
            'Business context of the task/feature/fix: purpose, boundaries ("fence"), invariants. ' +
              'Lets the engine judge whether the change fits the intended behavior, not just the diff itself.',
          ),
      },
    },
    async ({ diff, title, description, taskContext }) => {
      const reviewed = await reviewDiff({ diff, title, description, taskContext }, rules, judge);
      if (!reviewed.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Review failed: ${reviewed.error}` }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(reviewed.value) }] };
    },
  );

  return server;
}
