import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Union Settlement',
  description: 'ClubGG union settlement admin',
  robots: 'noindex, nofollow',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
