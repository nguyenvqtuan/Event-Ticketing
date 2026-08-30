import Link from 'next/link';
import { type EventListResponse } from '@repo/contracts';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';

/**
 * The events list (TICK-F2).
 *
 * `GET /events` was added for this page — the API had no collection endpoint,
 * only create, get-by-id and the seat page.
 */

/** Availability changes constantly; a cached list would show stale sale states. */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

type LoadResult =
  | { status: 'ok'; page: EventListResponse }
  | { status: 'unavailable'; message: string; correlationId: string | null };

/**
 * Fetching is kept out of the render for the reason eslint's
 * `react-hooks/error-boundaries` gives: React renders elements later, so a
 * `try` wrapped around JSX cannot catch rendering errors while quietly
 * swallowing the ones it does catch.
 */
async function load(offset: number): Promise<LoadResult> {
  try {
    return { status: 'ok', page: await api.listEvents({ limit: PAGE_SIZE, offset }) };
  } catch (error) {
    if (error instanceof ApiError) {
      return { status: 'unavailable', message: error.message, correlationId: error.correlationId };
    }
    throw error;
  }
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
  const { offset: rawOffset } = await searchParams;
  const offset = Math.max(0, Number(rawOffset ?? 0) || 0);

  const result = await load(offset);

  if (result.status === 'unavailable') {
    return (
      <main className="page">
        <h1>Events</h1>
        <p className="muted">The API could not be reached: {result.message}</p>
        {result.correlationId && (
          <p className="muted" style={{ fontSize: '0.75rem' }}>
            Correlation id: <code>{result.correlationId}</code>
          </p>
        )}
      </main>
    );
  }

  const { events, pagination } = result.page;

  return (
    <main className="page">
      <h1 style={{ fontSize: '2rem', margin: '0 0 0.25rem' }}>Events</h1>
      <p className="muted" style={{ margin: 0 }}>
        {pagination.total === 0
          ? 'Nothing scheduled yet.'
          : `${pagination.total} event${pagination.total === 1 ? '' : 's'}, soonest first.`}
      </p>

      {events.length === 0 ? (
        // Two different empty states. Paging past the end is not the same as
        // having no events, and saying "no events yet" under a header that
        // just counted them reads as a bug.
        pagination.total === 0 ? (
          <EmptyState />
        ) : (
          <OffTheEnd />
        )
      ) : (
        <ul className="event-grid">
          {events.map((event) => (
            <li key={event.id}>
              <Link href={`/events/${event.id}`} className="event-card">
                <span className={`badge${event.onSale ? ' badge--on-sale' : ''}`}>
                  {event.onSale ? 'On sale' : 'Not on sale'}
                </span>
                <h2 style={{ fontSize: '1.125rem', margin: '0.625rem 0 0.25rem' }}>{event.name}</h2>
                <p className="muted" style={{ margin: 0, fontSize: '0.875rem' }}>
                  {when(event.startsAt)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Pagination offset={pagination.offset} limit={pagination.limit} total={pagination.total} />
    </main>
  );
}

/**
 * An empty list is a normal state, not an error — the API answers 200 with no
 * rows. It says how to get one rather than leaving a blank page.
 */
function EmptyState() {
  return (
    <div className="empty">
      <p style={{ margin: '0 0 0.5rem' }}>No events yet.</p>
      <p className="muted" style={{ margin: 0, fontSize: '0.875rem' }}>
        Create one with <code>POST /events</code>, or run{' '}
        <code>./apps/api/scripts/smoke-test.sh http://localhost:3000 --full</code>
      </p>
    </div>
  );
}

/** Asked for a page beyond the last one — recoverable, so it says how. */
function OffTheEnd() {
  return (
    <div className="empty">
      <p style={{ margin: '0 0 0.5rem' }}>Nothing on this page.</p>
      <Link href="/events" className="back">
        Back to the first page
      </Link>
    </div>
  );
}

function Pagination({ offset, limit, total }: { offset: number; limit: number; total: number }) {
  const previous = offset - limit;
  const next = offset + limit;

  if (total <= limit) return null;

  return (
    <nav
      style={{ display: 'flex', gap: '1rem', marginTop: '2rem', alignItems: 'center' }}
      aria-label="Pagination"
    >
      {offset > 0 && (
        <Link href={`/events?offset=${Math.max(0, previous)}`} className="back">
          ← Previous
        </Link>
      )}
      <span className="muted" style={{ fontSize: '0.875rem' }}>
        {offset + 1}–{Math.min(next, total)} of {total}
      </span>
      {next < total && (
        <Link href={`/events?offset=${next}`} className="back">
          Next →
        </Link>
      )}
    </nav>
  );
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
