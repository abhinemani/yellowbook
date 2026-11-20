-- v2: whether each contact email domain still receives mail (DNS MX lookup). Domains only; no addresses.
CREATE TABLE IF NOT EXISTS email_domains (
  domain      TEXT PRIMARY KEY COLLATE NOCASE,
  status      TEXT NOT NULL CHECK (status IN ('mx','a_only','no_mail','nxdomain','error')),
  mx_hosts    TEXT,                                   -- comma-separated, lowest preference first
  checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
