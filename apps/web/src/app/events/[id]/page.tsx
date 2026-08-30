import Link from 'next/link';
import { type EventResponse, type SeatPageResponse } from '@repo/contracts';
import { BookingFlow } from '@/components/booking-flow';
import { api } from '@/lib/api/client';
import { ApiError, NotFoundError } from '@/lib/api/errors';

/**
 * One event, with its seat map (TICK-F2).
 *
 * A server component, so the fetch happens server-side and `API_URL` can be an
 * address only the server can reach. The map's state is real on first paint —
 * seats are fetched here and passed to the client component, rather than the
 * browser fetching them after hydration and flashing an empty grid first.
 */

/** Availability is the point of this page; a cached count is a lie. */
export const dynamic = 'force-dynamic';

/**
 * The API caps a seat page at 500. A larger venue needs paging or a windowed
 * map, which is a real design problem rather than a bigger number — flagged
 * here rather than silently drawing a partial map.
 */
const SEAT_PAGE_LIMIT = 500;

type LoadResult =
  | { status: 'ok'; event: EventResponse; seats: SeatPageResponse }
  | { status: 'not-found' }
  | { status: 'unavailable'; message: string; correlationId: string | null };

/**
 * Fetching is kept out of the render: React renders elements later, so a `try`
 * around JSX cannot catch rendering errors while quietly swallowing others.
 */
async function load(id: string): Promise<LoadResult> {
  try {
    const [event, seats] = await Promise.all([
      api.getEvent(id),
      // `ALL`, not the default `AVAILABLE`: a map draws every seat and colours
      // it, and one request means one instant rather than three stitched together.
      api.listSeats(id, { status: 'ALL', limit: SEAT_PAGE_LIMIT }),
    ]);

    return { status: 'ok', event, seats };
  } catch (error) {
    if (error instanceof NotFoundError) return { status: 'not-found' };

    if (error instanceof ApiError) {
      return { status: 'unavailable', message: error.message, correlationId: error.correlationId };
    }

    throw error;
  }
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await load(id);

  if (result.status === 'not-found') {
    return <Problem title="Event not found" detail={`No event with id ${id}.`} />;
  }

  if (result.status === 'unavailable') {
    return (
      <Problem
        title="The API could not be reached"
        detail={result.message}
        correlationId={result.correlationId}
      />
    );
  }

  const { event, seats } = result;
  const truncated = seats.pagination.total > seats.seats.length;

  return (
    <main className="page">
      <Link href="/events" className="back">
        ← All events
      </Link>

      <h1 style={{ fontSize: '2rem', lineHeight: 1.2, margin: '1rem 0 0.25rem' }}>{event.name}</h1>
      <p className="muted" style={{ margin: '0 0 1.5rem' }}>
        {when(event.startsAt)}
        {' · '}
        <span style={{ color: event.onSale ? 'var(--accent)' : 'var(--muted)' }}>
          {event.onSale ? 'On sale' : 'Not on sale'}
        </span>
      </p>

      <div className="stat-grid">
        <Stat label="Available" value={event.seats.available} />
        <Stat label="Held" value={event.seats.held} />
        <Stat label="Sold" value={event.seats.sold} />
        <Stat label="Total" value={event.seats.total} />
      </div>

      {truncated && (
        <p className="muted" style={{ fontSize: '0.875rem' }}>
          Showing the first {seats.seats.length} of {seats.pagination.total} seats.
        </p>
      )}

      <BookingFlow eventId={event.id} seats={seats.seats} />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <p style={{ margin: 0, fontSize: '1.5rem' }}>{value}</p>
      <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
        {label}
      </p>
    </div>
  );
}

function Problem({
  title,
  detail,
  correlationId,
}: {
  title: string;
  detail: string;
  correlationId?: string | null;
}) {
  return (
    <main className="page">
      <Link href="/events" className="back">
        ← All events
      </Link>
      <h1 style={{ fontSize: '1.5rem', margin: '1rem 0 0.5rem' }}>{title}</h1>
      <p className="muted" style={{ margin: 0 }}>
        {detail}
      </p>
      {correlationId && (
        // The id the API logged this under — what turns "it broke" into
        // something searchable.
        <p className="muted" style={{ fontSize: '0.75rem', marginTop: '1rem' }}>
          Correlation id: <code>{correlationId}</code>
        </p>
      )}
    </main>
  );
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
