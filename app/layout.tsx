import '@fontsource/open-sans/300.css';
import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/600.css';
import '@fontsource/open-sans/700.css';
import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getDb } from '@/lib/db';
import { Icon } from './ui';

export const metadata: Metadata = { title: 'yellowbook', description: 'Government contacts, kept current.' };
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pending = (getDb().prepare(`SELECT COUNT(*) n FROM checks WHERE review_state = 'pending'`).get() as { n: number }).n;
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="side" aria-label="Main">
            <div className="brand">yellow<b>book</b></div>
            <div className="nav">
              <Link href="/"><Icon name="grid" />Overview</Link>
              <Link href="/agencies"><Icon name="building" />Agencies</Link>
              <Link href="/review"><Icon name="check" />Review{pending > 0 && <span className="count">{pending}</span>}</Link>
              <Link href="/runs"><Icon name="play" />Runs</Link>
              <Link href="/roles"><Icon name="tag" />Roles</Link>
              <Link href="/data"><Icon name="file" />Import / Export</Link>
            </div>
          </nav>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
