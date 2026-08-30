import Link from 'next/link';

/**
 * The landing page. Browsing lives at `/events` now that the API has a
 * collection endpoint (added in TICK-F2); checkout arrives in TICK-F3.
 */
export default function Home() {
  return (
    <main className="page">
      <p className="eyebrow">Event Ticketing</p>

      <h1 style={{ fontSize: '2.25rem', lineHeight: 1.15, margin: '0.5rem 0 1rem' }}>
        Find a seat.
      </h1>

      <p className="muted" style={{ margin: '0 0 2rem', maxWidth: '34rem' }}>
        Browse what is on, open an event to see its seat map, and pick the seats you want.
        Availability is read live from the API on every load.
      </p>

      <Link href="/events" className="event-card" style={{ display: 'inline-block' }}>
        Browse events →
      </Link>
    </main>
  );
}
