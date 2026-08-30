/**
 * Shown while the events list is being fetched on the server.
 *
 * A skeleton of the same shape as the real list, rather than a spinner: the
 * page does not jump when the data lands, which is the point of showing
 * anything at all.
 */
export default function Loading() {
  return (
    <main className="page" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading events</span>
      <div className="skeleton" style={{ width: '8rem', height: '2rem' }} />
      <div className="skeleton" style={{ width: '14rem', height: '1rem', marginTop: '0.5rem' }} />

      <ul className="event-grid">
        {[0, 1, 2, 3].map((i) => (
          <li key={i}>
            <div
              className="skeleton"
              style={{ height: '7.5rem', borderRadius: '0.75rem' }}
              aria-hidden="true"
            />
          </li>
        ))}
      </ul>
    </main>
  );
}
