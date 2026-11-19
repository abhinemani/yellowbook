import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  building: <><path d="M4 21V5l8-3 8 3v16" /><path d="M9 21v-5h6v5" /><path d="M9 9h.01M15 9h.01M9 13h.01M15 13h.01" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 9.5" /></>,
  play: <><circle cx="12" cy="12" r="9" /><path d="M10 8.5l5 3.5-5 3.5z" /></>,
  tag: <><path d="M3 12V4h8l9 9-8 8z" /><path d="M7.5 8h.01" /></>,
  file: <><path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
};

export function Icon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function IconCircle({ name, navy }: { name: string; navy?: boolean }) {
  return (
    <span className={`icon-circle${navy ? ' navy' : ''}`}>
      <Icon name={name} />
    </span>
  );
}

const CHIP: Record<string, [string, string]> = {
  confirmed_in_role: ['confirmed', 'Confirmed'],
  replaced: ['replaced', 'Replaced'],
  role_mismatch: ['mismatch', 'Role mismatch'],
  vacant_interim: ['vacant', 'Vacant/interim'],
  unclear: ['unclear', 'Unclear'],
  unable_to_confirm: ['unable', 'Unable to confirm'],
};

/** Status is always shown as text as well as colour. */
export function StatusChip({ status }: { status: string | null | undefined }) {
  const [cls, label] = status && CHIP[status] ? CHIP[status] : ['unchecked', 'Not checked'];
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function Stat({ n, label, note, rose }: { n: string | number; label: string; note?: string; rose?: boolean }) {
  return (
    <div className="stat">
      <div className={`big-number${rose ? ' rose' : ''}`}>{typeof n === 'number' ? n.toLocaleString('en-US') : n}</div>
      <div className="label">{label}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export const usd = (n: number | null | undefined) => (n == null ? '' : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
export const pop = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US') : '');
export const day = (s: unknown) => (typeof s === 'string' ? s.slice(0, 10) : '');

export function Notice({ children, ok }: { children: ReactNode; ok?: boolean }) {
  return <div className={`notice${ok ? ' ok' : ''}`} role="status">{children}</div>;
}

export function safeLink(url: unknown): string | null {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}
