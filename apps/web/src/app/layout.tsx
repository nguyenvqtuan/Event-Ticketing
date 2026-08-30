import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Event Ticketing',
  description: 'Seat reservation and ticketing platform',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
