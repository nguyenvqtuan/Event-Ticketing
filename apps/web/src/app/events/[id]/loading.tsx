/**
 * Shown while an event and its seats are fetched.
 *
 * Mirrors the real layout — heading, stat row, seat grid — so the page does
 * not reflow when the data lands.
 */
export default function Loading() {
  return (
    <main className="page" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading event</span>
      <div className="skeleton" style={{ width: '18rem', height: '2.25rem', marginTop: '1rem' }} />
      <div
        className="skeleton"
        style={{ width: '12rem', height: '1rem', margin: '0.75rem 0 1.5rem' }}
      />

      <div className="stat-grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" style={{ height: '4.25rem' }} aria-hidden="true" />
        ))}
      </div>

      <div className="skeleton" style={{ height: '10rem' }} aria-hidden="true" />
    </main>
  );
}
