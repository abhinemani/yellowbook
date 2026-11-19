import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import Ajv from 'ajv';
import { cfg, type Config } from './config';
import { costUsd } from './pricing';
import { loadPrompt, render } from './prompts';
import { applyRules, hostOf } from './rules';
import type { Evidence, FinalCheck, ModelResult, RunKind, SeatContext, Tier } from './types';

type Params = Anthropic.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Messages.Message;

/** Contact-data aggregators carry exactly the stale data this app exists to correct. Never worth paying tokens to read. */
export const BLOCKED_DOMAINS = [
  'zoominfo.com', 'rocketreach.co', 'signalhire.com', 'lusha.com', 'contactout.com', 'apollo.io',
  'leadiq.com', 'adapt.io', 'dnb.com', 'clustrmaps.com', 'spokeo.com', 'whitepages.com',
];

export function modelFor(tier: Tier, c: Config = cfg()): string {
  return tier === 1 ? c.modelT1 : tier === 2 ? c.modelT2 : c.modelT3;
}

/** URLs the model is allowed to start from. The fetch tool can only open URLs that appear in the conversation. */
export function startUrls(seat: SeatContext): string[] {
  const urls: string[] = [];
  const add = (u: string | null) => {
    if (!u) return;
    const withScheme = /^[a-z]+:\/\//i.test(u) ? u : `https://${u}`;
    if (hostOf(withScheme) && !urls.includes(withScheme)) urls.push(withScheme);
  };
  add(seat.priorSourceUrl); // most specific first: the page that last named the holder
  add(seat.website);
  return urls;
}

/** Tier 1 needs somewhere to start. Without a URL, begin at tier 2. */
export function firstTier(seat: SeatContext): Tier {
  return startUrls(seat).length > 0 ? 1 : 2;
}

export function buildParams(seat: SeatContext, tier: Tier, kind: RunKind, today: Date, c: Config = cfg()): Params {
  const urls = startUrls(seat);
  const fetchMax = tier === 1 ? c.t1MaxFetches : c.t2MaxFetches;
  const vars = {
    today: today.toISOString().slice(0, 10),
    role_label: seat.roleLabel + (seat.slot > 1 ? ` (#${seat.slot})` : ''),
    agency_name: seat.agencyName,
    agency_category: seat.category,
    agency_state: seat.state,
    agency_county_clause: seat.county && seat.category !== 'county' ? `, ${seat.county} County` : '',
    role_definition: seat.roleDefinition,
    source_last_verified: seat.sourceLastVerified,
    contact_name: seat.contactName,
    contact_title: seat.contactTitle,
    contact_email: seat.contactEmail,
    contact_phone: seat.contactPhone,
    start_urls: urls.length ? urls.map((u) => `- ${u}`).join('\n') : '- (no website on file: search for the official site)',
    title_hints: seat.titleHints.join(', '),
    max_fetches: fetchMax,
    max_searches: c.t2MaxSearches,
  };
  const toolText = render(loadPrompt(tier === 1 ? 'tools_fetch_only' : 'tools_search'), vars);
  const template = loadPrompt(kind === 'discover' ? 'discover_contact' : 'verify_contact');
  const user = render(template, { ...vars, tool_instructions: toolText });

  const tools: Params['tools'] =
    tier === 1
      ? [
          {
            type: 'web_fetch_20250910',
            name: 'web_fetch',
            max_uses: fetchMax,
            max_content_tokens: c.maxContentTokens,
            allowed_domains: [...new Set(urls.map((u) => hostOf(u)).filter((h): h is string => !!h))],
            allowed_callers: ['direct'],
          },
        ]
      : [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: c.t2MaxSearches,
            blocked_domains: BLOCKED_DOMAINS,
            allowed_callers: ['direct'],
          },
          {
            type: 'web_fetch_20250910',
            name: 'web_fetch',
            max_uses: fetchMax,
            max_content_tokens: c.maxContentTokens,
            blocked_domains: BLOCKED_DOMAINS,
            allowed_callers: ['direct'],
          },
        ];

  return {
    model: modelFor(tier, c),
    max_tokens: c.maxOutputTokens,
    system: loadPrompt('system'),
    tools,
    output_config: { format: { type: 'json_schema', schema: outputSchema() } },
    messages: [{ role: 'user', content: user }],
  };
}

let apiSchema: Record<string, unknown> | null = null;
/**
 * The result contract in the dialect the API's structured outputs accept, so the response is
 * constrained to it (the prompt names the schema but the model cannot read the file).
 * The API rejects `enum` alongside a type list such as ["string", "null"], so a nullable enum
 * becomes anyOf [string enum, null]. Ajv still validates against the file itself.
 */
export function outputSchema(): Record<string, unknown> {
  if (apiSchema) return apiSchema;
  const s = JSON.parse(fs.readFileSync(path.resolve(/* turbopackIgnore: true */ cfg().root, 'schemas/check_result.schema.json'), 'utf8'));
  const properties: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(s.properties as Record<string, { type?: unknown; enum?: unknown[]; [x: string]: unknown }>)) {
    if (Array.isArray(p.enum) && Array.isArray(p.type) && p.type.includes('null')) {
      const { type: _t, enum: values, ...rest } = p;
      properties[k] = { ...rest, anyOf: [{ type: 'string', enum: values.filter((v) => v !== null) }, { type: 'null' }] };
    } else properties[k] = p;
  }
  apiSchema = { type: 'object', additionalProperties: false, required: s.required, properties };
  return apiSchema;
}

// ---------- reading a response ----------

interface LooseBlock {
  type: string;
  [k: string]: unknown;
}

export function extractEvidence(content: unknown[], usage?: { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null }): Evidence {
  const ev: Evidence = { pages: [], citedTexts: [], seenUrls: [], searches: 0, fetches: 0, searchOk: 0, fetchOk: 0, toolErrors: [] };
  const seen = new Set<string>();
  let searchBlocks = 0;
  let fetchBlocks = 0;
  for (const raw of content as LooseBlock[]) {
    if (raw.type === 'server_tool_use') {
      if (raw.name === 'web_search') searchBlocks++;
      if (raw.name === 'web_fetch') fetchBlocks++;
    } else if (raw.type === 'web_search_tool_result') {
      const c = raw.content;
      if (Array.isArray(c)) {
        ev.searchOk++;
        for (const r of c as { url?: string }[]) if (r.url) seen.add(r.url);
      } else if (c && typeof c === 'object' && 'error_code' in c) {
        ev.toolErrors.push(String((c as { error_code: unknown }).error_code));
      }
    } else if (raw.type === 'web_fetch_tool_result') {
      const c = raw.content as { type?: string; error_code?: string; url?: string; content?: { source?: { type?: string; data?: string } } } | undefined;
      if (c?.type === 'web_fetch_tool_error' || c?.type === 'web_fetch_tool_result_error' || c?.error_code) {
        ev.toolErrors.push(String(c?.error_code ?? 'unknown'));
      } else if (c?.type === 'web_fetch_result') {
        ev.fetchOk++;
        if (c.url) seen.add(c.url);
        const src = c.content?.source;
        if (src?.type === 'text' && typeof src.data === 'string' && c.url) ev.pages.push({ url: c.url, text: src.data });
      }
    } else if (raw.type === 'text' && Array.isArray(raw.citations)) {
      for (const cit of raw.citations as { url?: string; cited_text?: string }[]) {
        if (cit.cited_text) ev.citedTexts.push(cit.cited_text);
        if (cit.url) seen.add(cit.url);
      }
    }
  }
  ev.seenUrls = [...seen];
  ev.searches = usage?.server_tool_use?.web_search_requests ?? searchBlocks;
  ev.fetches = usage?.server_tool_use?.web_fetch_requests ?? fetchBlocks;
  return ev;
}

/** Pull the JSON object out of the model's final text. Tolerates code fences and stray prose. */
export function parseModelJson(content: unknown[]): unknown {
  const texts = (content as LooseBlock[]).filter((b) => b.type === 'text').map((b) => String(b.text ?? ''));
  for (const candidate of [texts[texts.length - 1], texts.join('\n')]) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('No JSON object found in the model response');
}

type Validator = ((x: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
let validator: Validator | null = null;
export function validateResult(obj: unknown): { ok: true; value: ModelResult } | { ok: false; error: string } {
  if (!validator) {
    const schema = JSON.parse(fs.readFileSync(path.resolve(/* turbopackIgnore: true */ cfg().root, 'schemas/check_result.schema.json'), 'utf8'));
    delete schema.$schema; // Ajv's default draft-07 build does not ship the 2020-12 meta-schema
    validator = new Ajv({ allErrors: true, strict: false }).compile(schema) as unknown as Validator;
  }
  if (validator!(obj)) return { ok: true, value: obj as ModelResult };
  const err = (validator!.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
  return { ok: false, error: err || 'schema validation failed' };
}

export interface Finalized {
  check: FinalCheck | null;
  evidence: Evidence;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  validationError: string | null;
  incomplete: boolean;
}

/** Turn an API message into a stored-ready check: parse, validate, apply every rule, price it. */
export function finalize(seat: SeatContext, tier: Tier, message: Pick<Message, 'content' | 'usage' | 'stop_reason'>, batch: boolean, today: Date, c: Config = cfg()): Finalized {
  const usage = message.usage as Message['usage'] & { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null };
  const evidence = extractEvidence(message.content as unknown[], usage);
  const cost = costUsd({ model: modelFor(tier, c), usage, searches: evidence.searches, batch });
  const base = { evidence, cost, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };

  if (message.stop_reason === 'pause_turn') {
    return { ...base, check: null, validationError: 'paused: the server tool loop did not finish', incomplete: true };
  }
  let parsed: unknown;
  try {
    parsed = parseModelJson(message.content as unknown[]);
  } catch (e) {
    return { ...base, check: null, validationError: (e as Error).message, incomplete: false };
  }
  const v = validateResult(parsed);
  if (!v.ok) return { ...base, check: null, validationError: v.error, incomplete: false };

  const check = applyRules(v.value, {
    today,
    roleKey: seat.roleKey,
    roleMulti: seat.roleMulti,
    agencyWebsite: seat.website,
    listedName: seat.contactName,
    evidence,
  });
  return { ...base, check, validationError: null, incomplete: false };
}

/** What we store when the model's output cannot be used even after a retry. */
export function modelErrorCheck(error: string): FinalCheck {
  return {
    status: 'unable_to_confirm',
    found_name: null, found_title: null, found_email: null, found_email_is_generic: false, found_phone: null,
    source_url: null, evidence_date: null, confidence: null,
    unresolved_reason: 'model_error',
    notes: `Model output could not be validated: ${error}`.slice(0, 300),
    flags: ['model_error'],
  };
}

/** Interactive (non-batch) call. Continues a paused server-tool turn a few times, summing usage. */
export async function callMessages(client: Anthropic, params: Params, maxContinues = 3): Promise<Pick<Message, 'content' | 'usage' | 'stop_reason'>> {
  const messages: Params['messages'] = [...params.messages];
  let content: Message['content'] = [];
  let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } } as unknown as Message['usage'] & { server_tool_use: { web_search_requests: number; web_fetch_requests: number } };
  let stop: Message['stop_reason'] = null;
  for (let i = 0; i <= maxContinues; i++) {
    const res = await client.messages.create({ ...params, messages });
    content = [...content, ...res.content];
    const u = res.usage as typeof usage;
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    usage.server_tool_use.web_search_requests += u.server_tool_use?.web_search_requests ?? 0;
    usage.server_tool_use.web_fetch_requests += u.server_tool_use?.web_fetch_requests ?? 0;
    stop = res.stop_reason;
    if (stop !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  return { content, usage, stop_reason: stop };
}
