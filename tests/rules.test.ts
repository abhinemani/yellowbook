import { describe, expect, it } from 'vitest';
import { applyRules, isGenericMailbox, isOfficialSource, needsEscalation, parseEvidenceDate, sameGovernmentHost } from '../src/lib/rules';
import type { Evidence, ModelResult, RuleContext } from '../src/lib/types';

const TODAY = new Date('2026-11-19T12:00:00Z');

function ev(over: Partial<Evidence> = {}): Evidence {
  return {
    pages: [{ url: 'https://www.examplecounty.gov/staff', text: 'Jane Doe, Purchasing Agent. jane.doe@examplecounty.gov 555-0100' }],
    citedTexts: [],
    seenUrls: ['https://www.examplecounty.gov/staff', 'https://examplecounty.gov/agenda/2026-03-04'],
    searches: 0,
    fetches: 1,
    searchOk: 0,
    fetchOk: 1,
    toolErrors: [],
    ...over,
  };
}

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    today: TODAY,
    roleKey: 'head_of_purchasing',
    roleMulti: false,
    agencyWebsite: 'https://www.examplecounty.gov/',
    listedName: 'Jane Doe',
    evidence: ev(),
    ...over,
  };
}

function res(over: Partial<ModelResult> = {}): ModelResult {
  return {
    status: 'confirmed_in_role',
    found_name: 'Jane Doe',
    found_title: 'Purchasing Agent',
    found_email: 'jane.doe@examplecounty.gov',
    found_email_is_generic: false,
    found_phone: '555-0100',
    source_url: 'https://www.examplecounty.gov/staff',
    evidence_date: '2026-03-04',
    confidence: 'High',
    unresolved_reason: null,
    notes: 'Named on the staff page and in a March 2026 agenda.',
    ...over,
  };
}

describe('email must appear verbatim on a retrieved page', () => {
  it('keeps an email that is on the page', () => {
    const out = applyRules(res(), ctx());
    expect(out.found_email).toBe('jane.doe@examplecounty.gov');
    expect(out.flags).not.toContain('email_not_on_page');
  });

  it('keeps an email that is only in a citation', () => {
    const e = ev({ pages: [], citedTexts: ['contact jane.doe@examplecounty.gov today'] });
    const out = applyRules(res(), ctx({ evidence: e }));
    expect(out.found_email).toBe('jane.doe@examplecounty.gov');
  });

  it('moves a guessed email into notes as UNVERIFIED and nulls the field', () => {
    const out = applyRules(res({ found_email: 'jdoe@examplecounty.gov' }), ctx());
    expect(out.found_email).toBeNull();
    expect(out.notes).toContain('Pattern guess (UNVERIFIED): jdoe@examplecounty.gov');
    expect(out.flags).toContain('email_not_on_page');
  });

  it('matches case-insensitively', () => {
    const out = applyRules(res({ found_email: 'Jane.Doe@ExampleCounty.gov' }), ctx());
    expect(out.found_email).toBe('Jane.Doe@ExampleCounty.gov');
  });

  it('drops a malformed address without echoing it as a guess', () => {
    const out = applyRules(res({ found_email: 'jane doe at county' }), ctx());
    expect(out.found_email).toBeNull();
    expect(out.notes).not.toContain('Pattern guess');
  });

  it('flags a different email domain and caps High at Medium', () => {
    const e = ev({ pages: [{ url: 'https://www.examplecounty.gov/staff', text: 'Jane Doe jane.doe@othercity.org' }] });
    const out = applyRules(res({ found_email: 'jane.doe@othercity.org' }), ctx({ evidence: e }));
    expect(out.flags).toContain('email_domain_mismatch');
    expect(out.confidence).toBe('Medium');
  });
});

describe('High confidence needs a dated 2025+ official source', () => {
  it('keeps High with a 2026 official source', () => {
    expect(applyRules(res(), ctx()).confidence).toBe('High');
  });
  it('downgrades High with no date', () => {
    const out = applyRules(res({ evidence_date: null }), ctx());
    expect(out.confidence).toBe('Medium');
    expect(out.flags).toContain('high_needs_date');
  });
  it('downgrades High with a 2023 date', () => {
    expect(applyRules(res({ evidence_date: '2023-06-01' }), ctx()).confidence).toBe('Medium');
  });
  it('downgrades High when the source is not the agency domain', () => {
    const e = ev({ seenUrls: ['https://randomnews.example.com/story'] });
    const out = applyRules(res({ source_url: 'https://randomnews.example.com/story' }), ctx({ evidence: e }));
    expect(out.confidence).toBe('Medium');
    expect(out.flags).toContain('high_needs_official');
  });
  it('accepts an agenda platform whose subdomain names the agency', () => {
    const url = 'https://examplecounty.granicus.com/agenda/55';
    const out = applyRules(res({ source_url: url }), ctx({ evidence: ev({ seenUrls: [url] }) }));
    expect(out.confidence).toBe('High');
  });
  it('ignores a date in the future', () => {
    const out = applyRules(res({ evidence_date: '2027-01-01' }), ctx());
    expect(out.evidence_date).toBeNull();
    expect(out.confidence).toBe('Medium');
  });
});

describe('replacements must name someone', () => {
  it('downgrades replaced with no name to unclear', () => {
    const out = applyRules(res({ status: 'replaced', found_name: null, found_email: null }), ctx());
    expect(out.status).toBe('unclear');
    expect(out.unresolved_reason).not.toBeNull();
  });
  it('downgrades replaced with no name to vacant_interim when notes say vacant', () => {
    const out = applyRules(res({ status: 'replaced', found_name: null, found_email: null, notes: 'Position is vacant per the 2026 org chart.' }), ctx());
    expect(out.status).toBe('vacant_interim');
  });
  it('treats "replaced" by the same person as confirmed', () => {
    const out = applyRules(res({ status: 'replaced', found_name: 'Jane Doe' }), ctx());
    expect(out.status).toBe('confirmed_in_role');
  });
  it('does not accept a confirmation of a different last name', () => {
    const out = applyRules(res({ status: 'confirmed_in_role', found_name: 'Sam Roe' }), ctx());
    expect(out.status).toBe('unclear');
    expect(out.flags).toContain('confirmed_name_differs');
  });
});

describe('subordinates are not the head', () => {
  it('turns a confirmed assistant into role_mismatch with Low confidence', () => {
    const out = applyRules(res({ found_title: 'Assistant Purchasing Agent' }), ctx());
    expect(out.status).toBe('role_mismatch');
    expect(out.confidence).toBe('Low');
  });
  it('does not accept a replacement who is a buyer', () => {
    const out = applyRules(res({ status: 'replaced', found_name: 'Sam Roe', found_title: 'Buyer II', found_email: null }), ctx());
    expect(out.status).toBe('unclear');
  });
  it('allows deputies for the deputy role', () => {
    const out = applyRules(
      res({ found_title: 'Deputy City Manager' }),
      ctx({ roleKey: 'deputy_top_appointed_executive', roleMulti: true }),
    );
    expect(out.status).toBe('confirmed_in_role');
  });
});

describe('"not searched" is never reported as "not found"', () => {
  const none = ev({ pages: [], seenUrls: [], searches: 0, fetches: 0, fetchOk: 0, searchOk: 0 });
  it('discards a confident answer that used no tools', () => {
    const out = applyRules(res(), ctx({ evidence: none }));
    expect(out.status).toBe('unable_to_confirm');
    expect(out.unresolved_reason).toBe('not_searched');
    expect(out.found_name).toBeNull();
    expect(out.found_email).toBeNull();
    expect(out.confidence).toBeNull();
  });
  it('corrects no_current_source to not_searched when nothing was run', () => {
    const out = applyRules(res({ status: 'unable_to_confirm', found_name: null, found_email: null, unresolved_reason: 'no_current_source', confidence: null }), ctx({ evidence: none }));
    expect(out.unresolved_reason).toBe('not_searched');
  });
  it('maps all-blocked fetches to fetch_blocked', () => {
    const blocked = ev({ pages: [], seenUrls: [], fetches: 2, fetchOk: 0, toolErrors: ['url_not_allowed', 'url_not_accessible'] });
    const out = applyRules(res({ status: 'unable_to_confirm', found_name: null, found_email: null, unresolved_reason: 'no_current_source', confidence: null }), ctx({ evidence: blocked }));
    expect(out.unresolved_reason).toBe('fetch_blocked');
  });
  it('maps a hit usage limit to budget_exhausted', () => {
    const limited = ev({ pages: [], seenUrls: [], searches: 2, fetches: 0, fetchOk: 0, toolErrors: ['max_uses_exceeded'] });
    const out = applyRules(res({ status: 'unable_to_confirm', found_name: null, found_email: null, unresolved_reason: 'no_current_source', confidence: null }), ctx({ evidence: limited }));
    expect(out.unresolved_reason).toBe('budget_exhausted');
  });
  it('keeps no_staff_listed when a page did load', () => {
    const out = applyRules(res({ status: 'unable_to_confirm', found_name: null, found_email: null, unresolved_reason: 'no_staff_listed', confidence: null }), ctx());
    expect(out.unresolved_reason).toBe('no_staff_listed');
  });
  it('clears the reason on a resolved status', () => {
    expect(applyRules(res({ unresolved_reason: 'no_current_source' }), ctx()).unresolved_reason).toBeNull();
  });
});

describe('source URL must have been seen', () => {
  it('nulls an invented URL and caps confidence at Low', () => {
    const out = applyRules(res({ source_url: 'https://www.examplecounty.gov/made-up' }), ctx());
    expect(out.source_url).toBeNull();
    expect(out.confidence).toBe('Low');
    expect(out.flags).toContain('source_not_seen');
  });
});

describe('notes carry evidence only', () => {
  it('redacts personal-matter language', () => {
    const out = applyRules(res({ notes: 'Left after an investigation into misconduct.' }), ctx());
    expect(out.notes).toContain('withheld by policy filter');
    expect(out.notes).not.toMatch(/misconduct/i);
    expect(out.flags).toContain('notes_redacted');
  });
  it('leaves ordinary notes alone', () => {
    expect(applyRules(res(), ctx()).notes).toContain('Named on the staff page');
  });
});

describe('generic mailboxes', () => {
  it('detects office mailboxes by pattern', () => {
    expect(isGenericMailbox('purchasing@examplecounty.gov')).toBe(true);
    expect(isGenericMailbox('Bids@examplecounty.gov')).toBe(true);
    expect(isGenericMailbox('jane.doe@examplecounty.gov')).toBe(false);
  });
  it('sets the flag even if the model did not', () => {
    const e = ev({ pages: [{ url: 'https://www.examplecounty.gov/staff', text: 'Reach us at purchasing@examplecounty.gov' }] });
    const out = applyRules(res({ found_email: 'purchasing@examplecounty.gov', found_email_is_generic: false }), ctx({ evidence: e }));
    expect(out.found_email_is_generic).toBe(true);
  });
});

describe('helpers', () => {
  it('parses partial dates and rejects junk', () => {
    expect(parseEvidenceDate('2026-03')?.text).toBe('2026-03');
    expect(parseEvidenceDate('March 2026')).toBeNull();
    expect(parseEvidenceDate(null)).toBeNull();
  });
  it('relates hosts of one government and not others', () => {
    expect(sameGovernmentHost('examplecounty.gov', 'examplecounty.org')).toBe(true);
    expect(sameGovernmentHost('ci.exampleville.mo.us', 'exampleville-mo.gov')).toBe(true);
    expect(sameGovernmentHost('examplecounty.gov', 'othercounty.gov')).toBe(false);
  });
  it('requires .gov when the agency has no website on file', () => {
    expect(isOfficialSource('https://x.example.gov/a', null)).toBe(true);
    expect(isOfficialSource('https://x.example.com/a', null)).toBe(false);
  });
});

describe('escalation', () => {
  it('escalates unresolved and low-confidence results', () => {
    expect(needsEscalation({ status: 'unable_to_confirm', confidence: null, unresolved_reason: 'no_staff_listed' })).toBe(true);
    expect(needsEscalation({ status: 'unclear', confidence: 'Low', unresolved_reason: 'no_current_source' })).toBe(true);
    expect(needsEscalation({ status: 'confirmed_in_role', confidence: 'Low', unresolved_reason: null })).toBe(true);
  });
  it('stops at Medium or better, and at model errors', () => {
    expect(needsEscalation({ status: 'confirmed_in_role', confidence: 'Medium', unresolved_reason: null })).toBe(false);
    expect(needsEscalation({ status: 'replaced', confidence: 'High', unresolved_reason: null })).toBe(false);
    expect(needsEscalation({ status: 'unable_to_confirm', confidence: null, unresolved_reason: 'model_error' })).toBe(false);
  });
});

import { isRetryableStatus } from '../src/lib/runs';
describe('sync retry policy', () => {
  it('does not resend requests the API rejected as invalid', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
  });
  it('resends overload, rate-limit and network failures', () => {
    for (const s of [429, 500, 529, 408, undefined]) expect(isRetryableStatus(s)).toBe(true);
  });
});
