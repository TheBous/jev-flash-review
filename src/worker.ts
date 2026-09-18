// Remote MCP entry: same engine, Streamable HTTP transport, one instance per
// request (stateless — no sessions, no Durable Objects). Bearer token required;
// the skills are transport-agnostic and work unchanged against this endpoint.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { TypeSafeJudge } from './judge.js';
import { createReviewServer } from './mcp/reviewServer.js';
import { parseRules, rawRules } from './rules.js';

const parsed = parseRules(rawRules);
if (!parsed.ok) {
  // Bundled rules are a build-time invariant: refuse to boot a broken worker.
  throw new Error(`Invalid bundled rules: ${parsed.error}`);
}

interface Env {
  TYPESAFE_API_KEY: string;
  REVIEW_BEARER: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (request.headers.get('authorization') !== `Bearer ${env.REVIEW_BEARER}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    const server = createReviewServer(
      parsed.value,
      new TypeSafeJudge({ apiKey: env.TYPESAFE_API_KEY }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
