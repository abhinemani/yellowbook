import Anthropic from '@anthropic-ai/sdk';
import { cfg } from './config';

export function getClient(): Anthropic {
  const key = cfg().apiKey;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  return new Anthropic({ apiKey: key, maxRetries: 3 });
}
