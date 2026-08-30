/**
 * @jest-environment jsdom
 */
// Imported rather than global: ESM jest does not inject `jest`, and this is
// the one suite that needs to move the clock.
import { jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type PayResponse, type ReservationResponse, type Seat } from '@repo/contracts';
import { BookingFlowView } from './booking-flow';
import { ConflictError, NetworkError } from '@/lib/api/errors';

/**
 * The booking flow is where the backend's concurrency semantics become a user
 * interface, so these assert the behaviours that actually protect a customer:
 * that a lost race names the seats, that an expired hold stops offering to pay,
 * and — the important one — that retrying a payment reuses the SAME
 * idempotency key rather than charging twice.
 *
 * The API client and the router refresh are both injected, so nothing here
 * touches a network and no module needs mocking — which under ESM jest would
 * mean `unstable_mockModule` and a dynamic import, for no benefit.
 */

const seat = (code: string, status: Seat['status'] = 'AVAILABLE'): Seat => ({
  id: `id-${code}`,
  code,
  priceMinor: 5000,
  currency: 'GBP',
  status,
});

const SEATS = [seat('A1'), seat('A2'), seat('A3', 'SOLD')];

const reservation = (expiresInMs = 900_000): ReservationResponse => ({
  id: 'res-1',
  eventId: 'evt-1',
  holderId: 'holder-1',
  seatIds: ['id-A1'],
  state: 'PENDING',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
});

const order: PayResponse = {
  orderId: 'ord-1',
  reservationId: 'res-1',
  state: 'PAID',
  seatIds: ['id-A1'],
  paid: { amountMinor: 5000, currency: 'GBP' },
};

interface Stubs {
  holdSeats?: (...args: never[]) => unknown;
  pay?: (...args: never[]) => unknown;
}

function stubClient(overrides: Stubs = {}) {
  const holdCalls: unknown[][] = [];
  const payCalls: { reservationId: string; key: string }[] = [];

  const client = {
    holdSeats: (...args: never[]) => {
      holdCalls.push(args);
      return (overrides.holdSeats ?? (() => Promise.resolve(reservation())))(...args);
    },
    pay: (reservationId: string, body: unknown, key: string) => {
      payCalls.push({ reservationId, key });
      return (overrides.pay ?? (() => Promise.resolve(order)))(
        ...([reservationId, body, key] as never[]),
      );
    },
    cancelReservation: () => Promise.resolve({} as never),
  };

  return { client, holdCalls, payCalls };
}

let refreshes = 0;

const renderFlow = (client: unknown, newKey = () => 'key-1') =>
  render(
    <BookingFlowView
      eventId="evt-1"
      seats={SEATS}
      client={client as never}
      newKey={newKey}
      onRefresh={() => {
        refreshes += 1;
      }}
    />,
  );

beforeEach(() => {
  refreshes = 0;
  window.localStorage.clear();
});

describe('selecting and holding', () => {
  it('holds the selected seats', async () => {
    const user = userEvent.setup();
    const { client, holdCalls } = stubClient();
    renderFlow(client);

    await user.click(screen.getByRole('button', { name: /Seat A1, available/ }));
    await user.click(screen.getByRole('button', { name: 'Hold these seats' }));

    await waitFor(() => expect(holdCalls).toHaveLength(1));
    expect(holdCalls[0]![0]).toMatchObject({ eventId: 'evt-1', seatIds: ['id-A1'] });
    expect(await screen.findByText(/Expires in/)).toBeTruthy();
  });

  it('cannot select a seat someone else already has', async () => {
    const { client } = stubClient();
    renderFlow(client);

    // Sold seats are disabled, not merely styled differently.
    expect(screen.getByRole('button', { name: /Seat A3, sold/ })).toBeDisabled();
  });
});

describe('losing a race for a seat', () => {
  it('names the seats that went and refreshes the map', async () => {
    const user = userEvent.setup();
    const { client } = stubClient({
      holdSeats: () =>
        Promise.reject(new ConflictError('Cannot hold seats', ['id-A1'], [], 409, null, 'corr-1')),
    });
    renderFlow(client);

    await user.click(screen.getByRole('button', { name: /Seat A1, available/ }));
    await user.click(screen.getByRole('button', { name: 'Hold these seats' }));

    // "Someone else took A1" — the seat CODE, not an id the user never saw.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Someone else took A1/);
    // Refreshed, so the map shows the seat as held rather than still clickable.
    await waitFor(() => expect(refreshes).toBeGreaterThan(0));
  });

  it('drops the lost seat from the selection so the retry is not doomed', async () => {
    const user = userEvent.setup();
    const { client } = stubClient({
      holdSeats: () => Promise.reject(new ConflictError('gone', ['id-A1'], [], 409, null, null)),
    });
    renderFlow(client);

    await user.click(screen.getByRole('button', { name: /Seat A1, available/ }));
    await user.click(screen.getByRole('button', { name: /Seat A2, available/ }));
    await user.click(screen.getByRole('button', { name: 'Hold these seats' }));

    await screen.findByRole('alert');
    // A2 survives; A1 does not, so pressing hold again does not re-ask for a
    // seat that is definitely gone.
    expect(await screen.findByText(/1 seat selected/)).toBeTruthy();
  });
});

describe('paying', () => {
  it('sends an idempotency key', async () => {
    const user = userEvent.setup();
    const { client, payCalls } = stubClient();
    renderFlow(client);

    await user.click(screen.getByRole('button', { name: /Seat A1, available/ }));
    await user.click(screen.getByRole('button', { name: 'Hold these seats' }));
    await user.click(await screen.findByRole('button', { name: /^Pay / }));

    await waitFor(() => expect(payCalls).toHaveLength(1));
    expect(payCalls[0]!.key).toBe('key-1');
  });

  it('REUSES the same key when a network failure is retried', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { client, payCalls } = stubClient({
      pay: () => {
        attempt += 1;
        // The first attempt dies in transit — the case where the server may
        // ALREADY have taken the payment.
        return attempt === 1
          ? Promise.reject(new NetworkError('Connection lost', 'corr-1'))
          : Promise.resolve(order);
      },
    });

    // A fresh key each time one is asked for, so reuse cannot pass by accident.
    let keys = 0;
    renderFlow(client, () => `key-${++keys}`);

    await user.click(screen.getByRole('button', { name: /Seat A1, available/ }));
    await user.click(screen.getByRole('button', { name: 'Hold these seats' }));
    await user.click(await screen.findByRole('button', { name: /^Pay / }));

    // The failure says retrying is safe, because with the same key it is.
    expect(await screen.findByRole('alert')).toHaveTextContent(/retrying is safe/);

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(payCalls).toHaveLength(2));
    // THE assertion of this ticket: a second charge is impossible because the
    // server sees the same key and replays the first order.
    expect(payCalls[0]!.key).toBe(payCalls[1]!.key);
  });

  it('shows the confirmed order on success', async () => {
    const user = userEvent.setup();
    const { client } = stubClient();
    renderFlow(client);

    await user.click(screen.getByRole('button', { name: /Seat A1, available/ }));
    await user.click(screen.getByRole('button', { name: 'Hold these seats' }));
    await user.click(await screen.findByRole('button', { name: /^Pay / }));

    expect(await screen.findByText(/your seats are confirmed/i)).toBeTruthy();
    expect(screen.getByText('ord-1')).toBeTruthy();
  });

  it('reports a refused payment without pretending it succeeded', async () => {
    const user = userEvent.setup();
    const { client } = stubClient({
      pay: () =>
        Promise.reject(new ConflictError('This hold has expired', [], [], 409, null, null)),
    });
    renderFlow(client);

    await user.click(screen.getByRole('button', { name: /Seat A1, available/ }));
    await user.click(screen.getByRole('button', { name: 'Hold these seats' }));
    await user.click(await screen.findByRole('button', { name: /^Pay / }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/This hold has expired/);
    expect(screen.queryByText(/your seats are confirmed/i)).toBeNull();
  });
});

describe('a hold that lapses', () => {
  it('stops offering to pay once the countdown reaches zero', async () => {
    jest.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    const { client } = stubClient({
      // Two seconds of hold, so the deadline passes inside the test.
      holdSeats: () => Promise.resolve(reservation(2_000)),
    });
    renderFlow(client);

    await user.click(screen.getByRole('button', { name: /Seat A1, available/ }));
    await user.click(screen.getByRole('button', { name: 'Hold these seats' }));
    await screen.findByText(/Expires in/);

    jest.advanceTimersByTime(3_000);

    // The server would refuse the payment anyway; not offering it is the
    // difference between an explanation and a confusing error.
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent(/that hold expired/i);

    jest.useRealTimers();
  });
});
