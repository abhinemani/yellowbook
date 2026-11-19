import type { Confidence, Evidence, FinalCheck, ModelResult, Reason, RuleContext, Status } from './types';

/**
 * The integrity rules. The model is not trusted to follow them; every result passes through
 * applyRules() before it is stored. Pure functions, no I/O. See docs/VERIFICATION.md.
 */

const HIGH_CUTOFF = new Date('2025-01-01T00:00:00Z');

const GENERIC_LOCAL = /^(purchasing|procurement|bids?|rfp|contracts?|finance|accounting|info|contact|admin|administration|clerk|cityclerk|countyclerk|office|general|support|help|hr|it|dpw|publicworks|services|customerservice|webmaster|mayor|citymanager|manager)$/i;

const SUBORDINATE_TITLE = /\b(assistant|asst\.?|associate|specialist|buyer|analyst|coordinator|technician|intern|clerk typist|secretary)\b/i;
const DEPUTY_TITLE = /\bdeputy\b/i;

/** Personal-matter language. A hit redacts the note rather than storing it. */
const NOTES_DENY = /\b(arrest(ed|s)?|charged|indict(ed|ment)|lawsuit|sued|divorc\w*|alleg(ation|ations|ed|edly)|misconduct|harass\w*|convict(ed|ion)|DUI|investigat(ion|ed|ing)|scandal|embezzl\w*|fraud|abuse[ds]?)\b/i;

/** Hosts that carry agency documents but are not the agency's own domain. Their subdomain names the agency. */
const PLATFORM_LABELS = new Set([
  'granicus', 'legistar', 'civicclerk', 'civicplus', 'municode', 'novusagenda', 'primegov', 'opengov',
  'bidnetdirect', 'publicpurchase', 'govdelivery', 'municipalcms', 'cloudfront', 'amazonaws', 'wordpress',
  'squarespace', 'wixsite', 'civicweb', 'iqm2', 'boarddocs', 'escribemeetings', 'destinyhosted', 'ci',
]);
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The label that identifies the owner of a host: "examplecounty" for www.examplecounty.gov, "exampleville" for ci.exampleville.mo.us. */
function ownerLabel(host: string): string {
  const labels = host.split('.');
  const n = labels.length;
  if (n === 1) return labels[0];
  let label = labels[n - 2];
  if (labels[n - 1] === 'us' && n >= 3 && labels[n - 2].length === 2) label = labels[n - 3];
  else if (PLATFORM_LABELS.has(label) && n >= 3) label = labels[n - 3];
  return label;
}

/** "cityofexample" and "example-mo" reduce to "example". Suffixes like "county" are kept so look-alikes do not match. */
function normalizeOwner(label: string): string {
  return label
    .toLowerCase()
    .replace(/^(cityof|townof|countyof|villageof|boroughof)/, '')
    .replace(/-[a-z]{2}$/, '')
    .replace(/-/g, '');
}

/** True if two hosts plausibly belong to the same government. Deliberately conservative: equal owners, not look-alikes. */
export function sameGovernmentHost(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const x = normalizeOwner(ownerLabel(a));
  const y = normalizeOwner(ownerLabel(b));
  return x.length >= 4 && x === y;
}

/** Official = the agency's own domain, or an agenda/document platform whose subdomain names the agency. */
export function isOfficialSource(sourceUrl: string | null, agencyWebsite: string | null): boolean {
  const host = hostOf(sourceUrl);
  if (!host) return false;
  const agencyHost = hostOf(agencyWebsite);
  if (!agencyHost) return host.endsWith('.gov'); // no website on file: only a .gov host counts
  return sameGovernmentHost(host, agencyHost);
}

export function isGenericMailbox(email: string | null): boolean {
  if (!email) return false;
  const local = email.split('@')[0]?.replace(/[._-]/g, '') ?? '';
  return GENERIC_LOCAL.test(local);
}

function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t === '' || /^(null|n\/a|none|unknown)$/i.test(t) ? null : t;
}

/** Accepts YYYY-MM-DD, YYYY-MM, YYYY. Returns a normalized string and a Date, or null. */
export function parseEvidenceDate(s: string | null): { text: string; date: Date } | null {
  const t = clean(s);
  if (!t) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : 1;
  const d = m[3] ? Number(m[3]) : 1;
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(date.getTime())) return null;
  const text = `${m[1]}${m[2] ? `-${m[2]}` : ''}${m[3] ? `-${m[3]}` : ''}`;
  return { text, date };
}

function normName(s: string | null): string[] {
  return (s ?? '')
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|jr|sr|ii|iii|iv)\b\.?/g, ' ')
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function sameLastName(a: string | null, b: string | null): boolean {
  const x = normName(a);
  const y = normName(b);
  if (!x.length || !y.length) return true; // cannot compare: do not accuse
  return x[x.length - 1] === y[y.length - 1];
}

function sameFullName(a: string | null, b: string | null): boolean {
  const x = normName(a);
  const y = normName(b);
  return x.length > 0 && y.length > 0 && x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}

function emailOnPage(email: string, ev: Evidence): boolean {
  const e = email.toLowerCase();
  return ev.pages.some((p) => p.text.toLowerCase().includes(e)) || ev.citedTexts.some((c) => c.toLowerCase().includes(e));
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;

function toolsBlockedReason(ev: Evidence): Reason | null {
  if (ev.fetchOk + ev.searchOk > 0 || ev.toolErrors.length === 0) return null;
  const budgetish = ev.toolErrors.some((c) => /max_uses_exceeded|too_many_requests|unavailable/.test(c));
  return budgetish ? 'budget_exhausted' : 'fetch_blocked';
}

const rank: Record<Confidence, number> = { Low: 0, Medium: 1, High: 2 };
function capConfidence(c: Confidence | null, cap: Confidence): Confidence {
  if (c == null) return cap === 'High' ? 'Low' : cap;
  return rank[c] > rank[cap] ? cap : c;
}

/**
 * Apply every rule and return the result that may be stored. Never throws on model output;
 * anything it cannot trust is downgraded, nulled or flagged.
 */
export function applyRules(input: ModelResult, ctx: RuleContext): FinalCheck {
  const flags: string[] = [];
  const extraNotes: string[] = [];
  const ev = ctx.evidence;

  const r: FinalCheck = {
    status: input.status,
    found_name: clean(input.found_name),
    found_title: clean(input.found_title),
    found_email: clean(input.found_email),
    found_email_is_generic: Boolean(input.found_email_is_generic),
    found_phone: clean(input.found_phone),
    source_url: clean(input.source_url),
    evidence_date: null,
    confidence: input.confidence,
    unresolved_reason: input.unresolved_reason,
    notes: clean(input.notes) ?? '',
    flags,
  };

  // 0. A result built on no tool use and no evidence is the model answering from memory. Not usable.
  const usedTools = ev.searches + ev.fetches > 0;
  const hasEvidence = ev.pages.length > 0 || ev.seenUrls.length > 0;
  const claimsFinding = r.status !== 'unable_to_confirm';
  if (claimsFinding && (!usedTools || !hasEvidence) && r.status !== 'unclear') {
    flags.push('no_evidence');
    r.status = 'unable_to_confirm';
    r.found_name = r.found_title = r.found_email = r.found_phone = r.source_url = null;
    r.found_email_is_generic = false;
    r.unresolved_reason = usedTools ? (toolsBlockedReason(ev) ?? 'no_current_source') : 'not_searched';
    extraNotes.push('Discarded: the answer had no fetched or searched evidence behind it.');
  }

  // 1. Date: valid, not in the future.
  const parsed = parseEvidenceDate(input.evidence_date);
  if (parsed) {
    if (parsed.date.getTime() > ctx.today.getTime() + 86_400_000) {
      flags.push('future_date');
    } else {
      r.evidence_date = parsed.text;
    }
  } else if (clean(input.evidence_date)) {
    flags.push('bad_date');
  }

  // 2. The source URL must be one the model could have seen.
  if (r.source_url && !ev.seenUrls.some((u) => u === r.source_url || stripSlash(u) === stripSlash(r.source_url!))) {
    flags.push('source_not_seen');
    extraNotes.push('Cited source URL was not among the pages retrieved.');
    r.source_url = null;
    r.evidence_date = null;
    r.confidence = capConfidence(r.confidence, 'Low');
  }

  // 3. An email is stored only if it appears verbatim on a retrieved page.
  if (r.found_email) {
    const e = r.found_email;
    if (!EMAIL_RE.test(e) || !emailOnPage(e, ev)) {
      flags.push('email_not_on_page');
      if (EMAIL_RE.test(e)) extraNotes.push(`Pattern guess (UNVERIFIED): ${e}`);
      r.found_email = null;
      r.found_email_is_generic = false;
    }
  }
  if (r.found_email) {
    r.found_email_is_generic = r.found_email_is_generic || isGenericMailbox(r.found_email);
    const agencyHost = hostOf(ctx.agencyWebsite);
    const emailHost = r.found_email.split('@')[1]?.toLowerCase() ?? null;
    if (agencyHost && emailHost && !sameGovernmentHost(emailHost, agencyHost)) {
      flags.push('email_domain_mismatch');
      extraNotes.push("Email domain differs from the agency's website domain.");
      r.confidence = r.confidence === 'High' ? 'Medium' : r.confidence;
    }
  }

  // 4. Status consistency.
  if (r.status === 'replaced' && !r.found_name) {
    flags.push('replaced_without_name');
    r.status = /\b(vacant|interim|acting|unfilled|open position)\b/i.test(r.notes) ? 'vacant_interim' : 'unclear';
  }
  if (r.status === 'confirmed_in_role' && !r.found_name) {
    flags.push('confirmed_without_name');
    r.status = 'unclear';
  }
  if (r.status === 'replaced' && ctx.listedName && sameFullName(ctx.listedName, r.found_name)) {
    flags.push('replaced_is_same_person');
    r.status = 'confirmed_in_role';
  }
  if (r.status === 'confirmed_in_role') {
    if (!ctx.listedName) {
      // discovery mode: "confirmed" means "holder found"; fine.
    } else if (!sameLastName(ctx.listedName, r.found_name)) {
      flags.push('confirmed_name_differs');
      extraNotes.push(`Found name differs from the listed person (${ctx.listedName}).`);
      r.status = 'unclear';
    }
  }

  // 5. Subordinate titles are not the head of a function.
  const holderStatuses: Status[] = ['confirmed_in_role', 'replaced', 'role_mismatch'];
  if (r.found_title && holderStatuses.includes(r.status) && r.found_name) {
    const sub = SUBORDINATE_TITLE.test(r.found_title) || (!ctx.roleMulti && DEPUTY_TITLE.test(r.found_title));
    const titleIsSubForThisRole = sub && !(ctx.roleKey === 'head_clerk' && /clerk/i.test(r.found_title));
    if (titleIsSubForThisRole && !ctx.roleMulti) {
      flags.push('subordinate_title');
      extraNotes.push('Title suggests a subordinate role, not the head of this function.');
      r.confidence = capConfidence(r.confidence, 'Low');
      if (r.status === 'replaced') r.status = 'unclear';
      else if (r.status === 'confirmed_in_role') r.status = ctx.listedName ? 'role_mismatch' : 'unclear';
    }
  }

  // 6. Confidence: High needs a dated (2025+) official source.
  if (r.status === 'unable_to_confirm') {
    r.confidence = null;
  } else {
    if (r.confidence == null) r.confidence = 'Low';
    if (r.confidence === 'High') {
      const dated = r.evidence_date != null && parseEvidenceDate(r.evidence_date)!.date >= HIGH_CUTOFF;
      const official = isOfficialSource(r.source_url, ctx.agencyWebsite);
      if (!dated || !official) {
        flags.push(!dated ? 'high_needs_date' : 'high_needs_official');
        r.confidence = 'Medium';
      }
    }
  }

  // 7. Unresolved reasons: required for unable/unclear; "not searched" is never reported as "not found".
  if (r.status === 'unable_to_confirm' || r.status === 'unclear') {
    let reason = r.unresolved_reason;
    if (!usedTools) reason = 'not_searched';
    else {
      const blocked = toolsBlockedReason(ev);
      if (blocked && (reason == null || reason === 'no_current_source' || reason === 'no_staff_listed')) reason = blocked;
    }
    if (reason == null) reason = 'no_current_source';
    if (reason !== r.unresolved_reason) flags.push('reason_corrected');
    r.unresolved_reason = reason;
  } else {
    r.unresolved_reason = null;
  }

  // 8. Notes: evidence and dates only.
  if (NOTES_DENY.test(r.notes)) {
    flags.push('notes_redacted');
    r.notes = `Evidence: ${r.source_url ?? 'none'} (${r.evidence_date ?? 'undated'}). Notes withheld by policy filter.`;
  }
  const merged = [r.notes, ...extraNotes].filter(Boolean).join(' ');
  r.notes = merged.length > 600 ? `${merged.slice(0, 597)}...` : merged;

  return r;
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, '').toLowerCase();
}

/** Should this result be retried at the next tier? Only paid-for effort that failed to settle the seat escalates. */
export function needsEscalation(
  c: Pick<FinalCheck, 'status' | 'confidence' | 'unresolved_reason'>,
  escalateBelow: Confidence = 'Medium',
): boolean {
  if (c.status === 'unable_to_confirm' || c.status === 'unclear') return c.unresolved_reason !== 'model_error';
  if (c.confidence == null) return true;
  return rank[c.confidence] < rank[escalateBelow];
}

/** Reasons that mean "we did not really look": retried automatically, with no cool-down. */
export const RETRYABLE_REASONS: Reason[] = ['not_searched', 'budget_exhausted', 'fetch_blocked'];
