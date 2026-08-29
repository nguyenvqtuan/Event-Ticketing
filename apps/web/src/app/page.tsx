const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function Home() {
  return (
    <main
      style={{
        maxWidth: '42rem',
        margin: '0 auto',
        padding: '4rem 1.5rem',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: '0.75rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        TICK-1 · Scaffold
      </p>

      <h1 style={{ fontSize: '2rem', lineHeight: 1.2, margin: '0.5rem 0 1rem' }}>
        Event Ticketing
      </h1>

      <p style={{ color: 'var(--muted)', margin: '0 0 2rem' }}>
        Placeholder page. The seat map, reservation flow, and checkout land in later tickets.
      </p>

      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: '0.5rem',
          padding: '1rem 1.25rem',
        }}
      >
        <h2 style={{ fontSize: '0.875rem', margin: '0 0 0.5rem' }}>API</h2>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
          Health endpoint:{' '}
          <a href={`${API_URL}/healthz`} style={{ color: 'var(--accent)' }}>
            {API_URL}/healthz
          </a>
        </p>
      </div>
    </main>
  );
}
