/**
 * Prices in USD per million tokens, from the Anthropic pricing page (checked Nov 2026).
 * Re-check before relying on cost numbers; update here only.
 */
interface Price {
  in: number;
  out: number;
  /** Haiku 5.5 charges more once a prompt passes 100k tokens. */
  inHi?: number;
  outHi?: number;
  hiThreshold?: number;
  cacheReadMult: number;
}

export const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, inHi: 0.5, outHi: 2.5, hiThreshold: 100_000, cacheReadMult: 0.1 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheReadMult: 0.05 },
  'claude-opus-5-5': { in: 4, out: 20, cacheReadMult: 0.05 },
  'claude-fable-5-2': { in: 8, out: 40, cacheReadMult: 0.025 },
};

export const SEARCH_USD_EACH = 0.01; // $10 per 1,000, no batch discount
export const BATCH_FACTOR = 0.5; // Batch API: 50% off input and output tokens

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function priceFor(model: string): Price {
  const p = PRICES[model];
  if (!p) throw new Error(`No price on file for model "${model}". Add it to src/lib/pricing.ts.`);
  return p;
}

/** Dollars for one request. Fetches cost nothing extra; their text is already in input_tokens. */
export function costUsd(opts: { model: string; usage: Usage; searches: number; batch: boolean }): number {
  const p = priceFor(opts.model);
  const input = (opts.usage.input_tokens ?? 0) + (opts.usage.cache_creation_input_tokens ?? 0) * 1.25;
  const cached = opts.usage.cache_read_input_tokens ?? 0;
  const output = opts.usage.output_tokens ?? 0;
  const hi = p.hiThreshold != null && input + cached > p.hiThreshold;
  const inRate = hi ? p.inHi! : p.in;
  const outRate = hi ? p.outHi! : p.out;
  const tokens = (input * inRate + cached * inRate * p.cacheReadMult + output * outRate) / 1_000_000;
  return tokens * (opts.batch ? BATCH_FACTOR : 1) + opts.searches * SEARCH_USD_EACH;
}
