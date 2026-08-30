'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type PayResponse, type ReservationResponse, type Seat } from '@repo/contracts';
import { type ApiClient, api as defaultApi } from '@/lib/api/client';
import { ApiError, ConflictError, NetworkError } from '@/lib/api/errors';
import { holderId } from '@/lib/holder';
import { money } from '@/lib/money';
import { SeatMap } from './seat-map';

/**
 * Select → hold → pay (TICK-F3).
 *
 * The backend's concurrency semantics are the whole design here. Three of them
 * leak into the UI whether we like it or not, so they are handled explicitly:
 *
 *   - A hold can lose a race. `POST /reservations` answers 409 with the seat
 *     ids that went, so the user is told WHICH seats, not just "try again".
 *   - A hold expires. The API returns `expiresAt` and enforces it server-side;
 *     the countdown here is a courtesy, and when it reaches zero the UI stops
 *     offering to pay rather than letting the request fail.
 *   - Paying is idempotent, and only if the client cooperates. One key per
 *     checkout attempt, REUSED on retry — see `idempotencyKey` below.
 */

type Phase =
  | { name: 'selecting' }
  | { name: 'holding' }
  | { name: 'held'; reservation: ReservationResponse }
  | { name: 'paying'; reservation: ReservationResponse }
  | { name: 'expired' }
  | { name: 'paid'; order: PayResponse };

/** The API refuses more than 20 seats per reservation. */
const MAX_SEATS = 20;

export interface BookingFlowProps {
  eventId: string;
  seats: readonly Seat[];
  /** Injected in tests; the default client is configured from the environment. */
  client?: Pick<ApiClient, 'holdSeats' | 'pay' | 'cancelReservation'>;
  /** Injected in tests, where `crypto.randomUUID` is not worth stubbing globally. */
  newKey?: () => string;
}

/**
 * What the page renders. Thin on purpose: it supplies the router refresh, and
 * everything else lives in `BookingFlowView`.
 *
 * The split exists so the flow can be tested without a Next router in scope.
 * The alternative — mocking `next/navigation` — means module mocking under ESM
 * jest, which is both awkward and a worse design: refreshing is an effect this
 * component causes, so taking it as a prop states that plainly.
 */
export function BookingFlow(props: BookingFlowProps) {
  const router = useRouter();

  return <BookingFlowView {...props} onRefresh={() => router.refresh()} />;
}

export function BookingFlowView({
  eventId,
  seats,
  client,
  newKey,
  onRefresh,
}: BookingFlowProps & { onRefresh: () => void }) {
  const api = client ?? defaultApi;

  const [selected, setSelected] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<Phase>({ name: 'selecting' });
  const [error, setError] = useState<string | null>(null);

  /**
   * One key per CHECKOUT ATTEMPT, not per request.
   *
   * This is the whole point of the idempotency contract: a client that retries
   * after a timeout cannot know whether the first attempt charged, so it must
   * send the same key — the server then replays the first order instead of
   * taking a second payment. Generating a fresh key on retry would defeat it
   * completely, which is why the key is state and not a local in `pay()`.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const chosen = useMemo(
    () => seats.filter((seat) => selected.includes(seat.id)),
    [seats, selected],
  );
  const total = chosen.reduce((sum, seat) => sum + seat.priceMinor, 0);
  const currency = chosen[0]?.currency ?? seats[0]?.currency ?? 'GBP';

  const codesFor = useCallback(
    (ids: readonly string[]) => {
      const byId = new Map(seats.map((seat) => [seat.id, seat.code]));
      return ids.map((id) => byId.get(id) ?? id);
    },
    [seats],
  );

  const toggle = (seat: Seat) => {
    setError(null);
    setSelected((current) =>
      current.includes(seat.id)
        ? current.filter((id) => id !== seat.id)
        : // Capped to match the API, so the limit is explained here rather
          // than arriving as a 400 on submit.
          current.length >= MAX_SEATS
          ? current
          : [...current, seat.id],
    );
  };

  async function hold() {
    setError(null);
    setPhase({ name: 'holding' });

    try {
      const reservation = await api.holdSeats({
        eventId,
        holderId: holderId(),
        seatIds: [...selected],
      });

      // A fresh attempt gets a fresh key; retries of THIS attempt reuse it.
      setIdempotencyKey((newKey ?? (() => crypto.randomUUID()))());
      setPhase({ name: 'held', reservation });
    } catch (caught) {
      setPhase({ name: 'selecting' });

      if (caught instanceof ConflictError) {
        const gone = codesFor(caught.unavailableSeatIds);
        const missing = codesFor(caught.missingSeatIds);

        setError(
          gone.length > 0
            ? `Someone else took ${gone.join(', ')}. The map has been refreshed.`
            : missing.length > 0
              ? `${missing.join(', ')} are not part of this event.`
              : caught.message,
        );

        // Re-fetch on the server so the map shows who actually has the seat,
        // rather than leaving a stale grid the user can click again.
        setSelected((current) => current.filter((id) => !caught.unavailableSeatIds.includes(id)));
        onRefresh();
        return;
      }

      setError(messageFor(caught));
    }
  }

  async function pay(reservation: ReservationResponse) {
    setError(null);
    setPhase({ name: 'paying', reservation });

    try {
      const order = await api.pay(
        reservation.id,
        { amountMinor: total, currency },
        // Never regenerated here: this is the same key the failed attempt used.
        idempotencyKey ?? '',
      );

      setPhase({ name: 'paid', order });
      onRefresh();
    } catch (caught) {
      // Back to `held`, with the key intact, so "Try again" is a genuine retry
      // of the same attempt rather than a second purchase.
      setPhase({ name: 'held', reservation });
      setError(
        caught instanceof NetworkError
          ? `${caught.message}. The payment may or may not have gone through — retrying is safe.`
          : messageFor(caught),
      );
    }
  }

  async function cancel(reservation: ReservationResponse) {
    setPhase({ name: 'selecting' });
    setSelected([]);
    setIdempotencyKey(null);

    try {
      await api.cancelReservation(reservation.id);
    } catch {
      // The hold expires on its own, so a failed cancel costs the user a wait
      // rather than a seat. Not worth an error message they cannot act on.
    }
    onRefresh();
  }

  const onExpired = useCallback(() => {
    setPhase({ name: 'expired' });
    setSelected([]);
    setIdempotencyKey(null);
    onRefresh();
  }, [onRefresh]);

  if (phase.name === 'paid') {
    return <Confirmation order={phase.order} onDone={() => setPhase({ name: 'selecting' })} />;
  }

  const locked = phase.name !== 'selecting';

  return (
    <>
      <SeatMap seats={seats} selected={selected} onToggle={toggle} disabled={locked} />

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      {phase.name === 'expired' && (
        <p className="notice" role="status">
          That hold expired and the seats went back on sale. Pick again.
        </p>
      )}

      {(phase.name === 'selecting' || phase.name === 'holding') && selected.length > 0 && (
        <div className="selection" role="status">
          <div>
            <strong>
              {chosen.length} seat{chosen.length === 1 ? '' : 's'} selected
            </strong>
            <span className="muted"> · {chosen.map((seat) => seat.code).join(', ')}</span>
            <div className="muted" style={{ fontSize: '0.875rem' }}>
              Total {money(total, currency)}
              {selected.length >= MAX_SEATS && ` · ${MAX_SEATS} is the most you can hold at once`}
            </div>
          </div>
          <button
            type="button"
            className="button"
            onClick={() => void hold()}
            disabled={phase.name === 'holding'}
          >
            {phase.name === 'holding' ? 'Holding…' : 'Hold these seats'}
          </button>
        </div>
      )}

      {(phase.name === 'held' || phase.name === 'paying') && (
        <div className="selection" role="status">
          <div>
            <strong>Held — {money(total, currency)}</strong>
            <span className="muted"> · {chosen.map((seat) => seat.code).join(', ')}</span>
            <div className="muted" style={{ fontSize: '0.875rem' }}>
              <Countdown expiresAt={phase.reservation.expiresAt} onExpired={onExpired} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <button
              type="button"
              className="back"
              onClick={() => void cancel(phase.reservation)}
              disabled={phase.name === 'paying'}
            >
              Release
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void pay(phase.reservation)}
              disabled={phase.name === 'paying'}
            >
              {phase.name === 'paying'
                ? 'Paying…'
                : error
                  ? 'Try again'
                  : `Pay ${money(total, currency)}`}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** A failure the user can read. Falls back to the API's own message. */
function messageFor(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return 'Something went wrong. Please try again.';
}

/**
 * Time left on the hold.
 *
 * Advisory only — the server decides, and its `valid_during` range is what
 * actually frees the seat. This exists so the deadline is visible, and so the
 * UI stops offering to pay for a hold that has certainly lapsed rather than
 * sending a request that will be refused.
 */
export function Countdown({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }) {
  const deadline = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(() => deadline - Date.now());

  useEffect(() => {
    // Recomputed from the clock each tick rather than decremented, so a
    // backgrounded tab that stops firing timers does not drift.
    const id = setInterval(() => setRemaining(deadline - Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);

  useEffect(() => {
    if (remaining <= 0) onExpired();
  }, [remaining, onExpired]);

  if (remaining <= 0) return <>Expired</>;

  const seconds = Math.floor(remaining / 1000);

  return (
    <>
      Expires in {String(Math.floor(seconds / 60)).padStart(2, '0')}:
      {String(seconds % 60).padStart(2, '0')}
    </>
  );
}

function Confirmation({ order, onDone }: { order: PayResponse; onDone: () => void }) {
  return (
    <div className="notice notice--success" role="status">
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.125rem' }}>
        Paid — your seats are confirmed
      </h2>
      <p style={{ margin: '0 0 0.25rem' }}>
        {order.seatIds.length} seat{order.seatIds.length === 1 ? '' : 's'} ·{' '}
        {money(order.paid.amountMinor, order.paid.currency)}
      </p>
      <p className="muted" style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem' }}>
        Order <code>{order.orderId}</code> · {order.state}
      </p>
      <button type="button" className="back" onClick={onDone}>
        Book more seats
      </button>
    </div>
  );
}
