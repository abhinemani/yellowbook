export type Status =
  | 'confirmed_in_role'
  | 'replaced'
  | 'role_mismatch'
  | 'vacant_interim'
  | 'unclear'
  | 'unable_to_confirm';

export type Reason =
  | 'not_searched'
  | 'budget_exhausted'
  | 'fetch_blocked'
  | 'no_staff_listed'
  | 'no_current_source'
  | 'model_error';

export type Confidence = 'High' | 'Medium' | 'Low';
export type Tier = 1 | 2 | 3;
export type RunKind = 'verify' | 'discover' | 'find_agency';

/** What the model must return for one seat (schemas/check_result.schema.json). */
export interface ModelResult {
  status: Status;
  found_name: string | null;
  found_title: string | null;
  found_email: string | null;
  found_email_is_generic: boolean;
  found_phone: string | null;
  source_url: string | null;
  evidence_date: string | null;
  confidence: Confidence | null;
  unresolved_reason: Reason | null;
  notes: string;
}

/** Everything observed in the API response that the rules can check the model's claims against. */
export interface Evidence {
  /** Text of pages the fetch tool returned (HTML/text only; PDFs arrive as base64 and are not searchable). */
  pages: { url: string; text: string }[];
  /** Short passages the API attached as citations. */
  citedTexts: string[];
  /** Every URL the model could legitimately have seen: fetched pages, search results, citations. */
  seenUrls: string[];
  searches: number;
  fetches: number;
  searchOk: number;
  fetchOk: number;
  /** Tool error codes seen (max_uses_exceeded, url_not_allowed, ...). */
  toolErrors: string[];
}

export interface RuleContext {
  today: Date;
  roleKey: string;
  roleMulti: boolean;
  agencyWebsite: string | null;
  /** The person we are verifying. null in discovery mode. */
  listedName: string | null;
  evidence: Evidence;
}

/** A result after the code-enforced rules have run. This is what gets stored. */
export interface FinalCheck extends ModelResult {
  flags: string[];
}

export interface SeatContext {
  seatId: number;
  slot: number;
  agencyId: number;
  agencyName: string;
  category: string;
  state: string;
  county: string | null;
  population: number | null;
  website: string | null;
  roleKey: string;
  roleLabel: string;
  roleDefinition: string;
  roleMulti: boolean;
  titleHints: string[];
  contactId: number | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  sourceLastVerified: string | null;
  /** Source URL of the last accepted check, if any: the cheapest place to start. */
  priorSourceUrl: string | null;
}
