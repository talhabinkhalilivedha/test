// USD per million tokens, used to show what each test cost and to enforce a run's cost cap.
// The claude CLI reports its own cost; these rates cover the API providers. Update them when prices change.
interface Rate { input: number; output: number; cacheRead: number; cacheWrite: number }

const RATES: Record<string, Rate> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
};

// OpenAI's Flex tier bills half the standard rates.
const TIER_FACTOR: Record<string, number> = { flex: 0.5 };

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export function costOf(model: string, u: Usage, tier?: string | null): number {
  const rate = RATES[model] ?? Object.entries(RATES).find(([k]) => model.startsWith(k))?.[1];
  if (!rate) return 0;
  const factor = (tier && TIER_FACTOR[tier]) || 1;
  return factor * (u.input * rate.input + u.output * rate.output + u.cacheRead * rate.cacheRead + u.cacheWrite * rate.cacheWrite) / 1e6;
}
