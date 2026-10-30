import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: '{{appTitle}}', template: '%s · {{appTitle}}' },
  description: '{{appTitle}}',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
