import Link from 'next/link';
import { type EventResponse, type SeatPageResponse } from '@repo/contracts';
import { api } from '@/lib/api/client';
import { ApiError, NotFoundError } from '@/lib/api/errors';

/**
 * The smoke page for TICK-F1: fetch an event through the typed client and
 * render it.
 *
 * A server component, so the call happens on the server and `API_URL` can be
 * an address only the server can reach. Nothing here is hand-typed —
 * `EventResponse` comes from `@repo/contracts`, which the API's controller is
 * compiled against.
 *
 * The seat map, selection and checkout arrive in TICK-F2 and TICK-F3. What
 * this proves is the foundation: the client reaches the API, the types line up
 * end to end, and a failure is a typed error the page branches on rather than
 * a stack trace.
 */

/** Always fresh: availability is the point, and a cached count is a lie. */
export const dynamic = 'force-dynamic';

type LoadResult =
  | { status: 'ok'; event: EventResponse; seats: SeatPageResponse }
  | { status: 'not-found' }
  | { status: 'unavailable'; message: string; correlationId: string | null };

/**
 * Fetching is separated from rendering because a `try` around JSX does not do
 * what it appears to: React returns an element and renders it later, so a
 * `catch` here would never see a rendering error while silently swallowing the
 * ones it does catch. Errors from FETCHING are caught here, where they really
 * happen; errors from rendering belong to an error boundary.
 */
async function load(id: string): Promise<LoadResult> {
  try {
    // Two calls: the overview carries the counts, the seat page the prices.
    const [event, seats] = await Promise.all([
      api.getEvent(id),
      api.listSeats(id, { status: 'AVAILABLE', limit: 5 }),
    ]);

    return { status: 'ok', event, seats };
  } catch (error) {
    if (error instanceof NotFoundError) return { status: 'not-found' };

    if (error instanceof ApiError) {
      return {
        status: 'unavailable',
        message: error.message,
        correlationId: error.correlationId,
      };
    }

    // Not ours to explain — let the error boundary have it.
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
  const cheapest = seats.seats[0];

  return (
    <main style={page}>
      <Link href="/" style={backLink}>
        ← Back
      </Link>

      <h1 style={{ fontSize: '2rem', lineHeight: 1.2, margin: '1rem 0 0.25rem' }}>{event.name}</h1>
      <p style={{ color: 'var(--muted)', margin: '0 0 1.5rem' }}>
        {when(event.startsAt)}
        {' · '}
        <span style={{ color: event.onSale ? 'var(--accent)' : 'var(--muted)' }}>
          {event.onSale ? 'On sale' : 'Not on sale'}
        </span>
      </p>

      <div style={grid}>
        <Stat label="Available" value={event.seats.available} />
        <Stat label="Held" value={event.seats.held} />
        <Stat label="Sold" value={event.seats.sold} />
        <Stat label="Total" value={event.seats.total} />
      </div>

      {cheapest ? (
        <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
          Seats from {money(cheapest.priceMinor, cheapest.currency)} — next available:{' '}
          {seats.seats.map((seat) => seat.code).join(', ')}
        </p>
      ) : (
        <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
          No seats are available for this event.
        </p>
      )}
    </main>
  );
}

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={card}>
      <p style={{ margin: 0, fontSize: '1.5rem' }}>{value}</p>
      <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--muted)' }}>{label}</p>
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
    <main style={page}>
      <Link href="/" style={backLink}>
        ← Back
      </Link>
      <h1 style={{ fontSize: '1.5rem', margin: '1rem 0 0.5rem' }}>{title}</h1>
      <p style={{ color: 'var(--muted)', margin: 0 }}>{detail}</p>
      {correlationId && (
        // The id the API logged this request under — what turns "it broke"
        // into something searchable.
        <p style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '1rem' }}>
          Correlation id: <code>{correlationId}</code>
        </p>
      )}
    </main>
  );
}

const page = { maxWidth: '42rem', margin: '0 auto', padding: '4rem 1.5rem' } as const;
const backLink = { color: 'var(--accent)', fontSize: '0.875rem' } as const;

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(6rem, 1fr))',
  gap: '0.75rem',
  margin: '0 0 1.5rem',
} as const;

const card = {
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  padding: '0.75rem 1rem',
} as const;
