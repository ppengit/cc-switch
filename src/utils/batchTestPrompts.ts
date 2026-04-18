// Random test prompts for batch stream-check. Short, cheap, provider-agnostic.
export const BATCH_TEST_PROMPTS = [
  "Say hi in one word.",
  "Reply with OK.",
  "Respond with the word pong.",
  "Answer with yes.",
  "Say ready in one word.",
  "Reply with hello.",
];

export function pickRandomTestPrompt(): string {
  const idx = Math.floor(Math.random() * BATCH_TEST_PROMPTS.length);
  return BATCH_TEST_PROMPTS[idx] ?? BATCH_TEST_PROMPTS[0];
}
