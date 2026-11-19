import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';

const cache = new Map<string, string>();

/** Load a prompt template: everything after the first line that is exactly `---`. */
export function loadPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const file = path.resolve(/* turbopackIgnore: true */ cfg().root, 'prompts', `${name}.md`);
  const raw = fs.readFileSync(file, 'utf8');
  const i = raw.split('\n').findIndex((l) => l.trim() === '---');
  const body = i < 0 ? raw : raw.split('\n').slice(i + 1).join('\n');
  const text = body.trim();
  cache.set(name, text);
  return text;
}

/** Fill {{placeholders}}. Throws on any placeholder left unfilled, so a broken template never reaches the API. */
export function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  const out = template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => {
    if (!(k in vars)) throw new Error(`Missing value for placeholder ${m}`);
    const v = vars[k];
    return v == null || v === '' ? 'not on file' : String(v);
  });
  const left = out.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`Unfilled placeholder ${left[0]}`);
  return out;
}

export function clearPromptCache(): void {
  cache.clear();
}
