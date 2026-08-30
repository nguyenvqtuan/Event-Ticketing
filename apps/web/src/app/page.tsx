import Link from 'next/link';

/**
 * The seat map, reservation flow and checkout land in TICK-F2 and TICK-F3.
 *
 * There is no events list yet because the API has no endpoint to build one
 * from — it exposes `POST /events`, `GET /events/:id` and the seat page, but
 * no collection. So this asks for an id rather than pretending to browse.
 */
export default async function Home({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;

  return (
    <main style={{ maxWidth: '42rem', margin: '0 auto', padding: '4rem 1.5rem' }}>
      <p style={eyebrow}>TICK-F1 · Frontend foundation</p>

      <h1 style={{ fontSize: '2rem', lineHeight: 1.2, margin: '0.5rem 0 1rem' }}>
        Event Ticketing
      </h1>

      <p style={{ color: 'var(--muted)', margin: '0 0 2rem' }}>
        The typed API client is wired up. Open an event to see it fetch and render real data.
      </p>

      <form style={{ display: 'flex', gap: '0.5rem', margin: '0 0 2rem' }}>
        <input
          name="id"
          defaultValue={id}
          placeholder="Event id (UUID)"
          aria-label="Event id"
          style={input}
        />
        <button type="submit" style={button}>
          Look up
        </button>
      </form>

      {id && (
        <p style={{ margin: '0 0 2rem' }}>
          <Link href={`/events/${id}`} style={{ color: 'var(--accent)' }}>
            Open /events/{id} →
          </Link>
        </p>
      )}

      <div style={panel}>
        <h2 style={{ fontSize: '0.875rem', margin: '0 0 0.5rem' }}>Getting an event id</h2>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
          The smoke test creates one and prints it:{' '}
          <code>./apps/api/scripts/smoke-test.sh http://localhost:3000 --full</code>
        </p>
      </div>
    </main>
  );
}

const eyebrow = {
  margin: 0,
  fontSize: '0.75rem',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
} as const;

const input = {
  flex: 1,
  padding: '0.5rem 0.75rem',
  borderRadius: '0.375rem',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
} as const;

const button = {
  padding: '0.5rem 1rem',
  borderRadius: '0.375rem',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
} as const;

const panel = {
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  padding: '1rem 1.25rem',
} as const;
