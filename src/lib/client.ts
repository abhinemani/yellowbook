import Anthropic from '@anthropic-ai/sdk';
import { cfg } from './config';

export function getClient(): Anthropic {
  const c = cfg();
  if (!c.apiKey) {
    throw new Error('No API key. Set YELLOWBOOK_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) in the environment or .env.');
  }
  return new Anthropic({ apiKey: c.apiKey, baseURL: c.apiBaseUrl, maxRetries: 3 });
}
