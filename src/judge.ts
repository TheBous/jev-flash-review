// Adapter: implements the Judge port with the TypeSafe System One API.
// The domain never imports this file — SDK vocabulary (choice) stops here.

import type { EntryType } from '@typesafe-ai/sdk';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type { ChoiceSpec, Judge, JudgeAnswers, PrState, TokenUsage } from './types.js';

export class TypeSafeJudge implements Judge {
  private readonly client: TypeSafeClient;

  constructor(timeoutMs = 60_000) {
    this.client = new TypeSafeClient({ timeout: timeoutMs });
  }

  async ask(
    state: PrState,
    questions: Record<string, ChoiceSpec>,
  ): Promise<{ answers: JudgeAnswers; usage: TokenUsage }> {
    const built = Object.fromEntries(
      Object.entries(questions).map(([key, spec]) => [key, choice(spec.input, spec.options)]),
    );
    // Anti-corruption boundary: the SDK expects its own EntryType shape here.
    const response = await this.client.systemOne({
      state: state as unknown as EntryType,
      questions: built,
    });
    return {
      answers: response.answers as JudgeAnswers,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
