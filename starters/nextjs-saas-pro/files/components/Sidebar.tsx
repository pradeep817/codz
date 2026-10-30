'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The app's sections. devtool screen add puts new pages under app/(app); add them here too. */
const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/settings', label: 'Settings' },
];

export default function Sidebar() {
  const path = usePathname();
  return (
    <nav className="sidebar" aria-label="Main">
      <p className="brand">{'{{appTitle}}'}</p>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path.startsWith(l.href) ? 'active' : undefined} aria-current={path.startsWith(l.href) ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
