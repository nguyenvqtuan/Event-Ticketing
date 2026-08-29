import { InvalidStateTransition } from '../../shared/domain/domain-error.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { Reservation } from '../domain/reservation.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';
import { ReservationNotFound } from './cancel-reservation.use-case.js';
import { ConfirmReservationUseCase } from './confirm-reservation.use-case.js';
import { ExpireReservationsUseCase } from './expire-reservations.use-case.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const TTL = 900;
const AFTER_TTL = new Date(NOW.getTime() + TTL * 1000);

const pendingHold = () =>
  Reservation.open({
    id: 'res-1',
    eventId: 'evt-1',
    holderId: 'holder-1',
    seatIds: ['seat-1'],
    now: NOW,
    ttlSeconds: TTL,
  });

class FakeReservations implements ReservationRepository {
  current: Reservation | null = pendingHold();
  lockedFor: string | null = null;
  extendedFor: string | null = null;
  expireLimit = 0;
  expiredCount = 0;

  save() {
    return Promise.resolve();
  }
  findById() {
    return Promise.resolve(this.current);
  }
  findByIdForUpdate(id: string) {
    this.lockedFor = id;
    return Promise.resolve(this.current);
  }
  updateState() {
    return Promise.resolve();
  }
  extendClaimsIndefinitely(id: string) {
    this.extendedFor = id;
    return Promise.resolve();
  }
  pricedSeatsFor() {
    return Promise.resolve([
      { seatId: 'seat-1', seatCode: 'A1', priceMinor: 5_000, currency: 'GBP' },
    ]);
  }
  markClaimsSold() {
    return Promise.resolve();
  }
  releaseClaims() {
    return Promise.resolve();
  }
  expireLapsed(limit: number) {
    this.expireLimit = limit;
    return Promise.resolve(this.expiredCount);
  }
}

class PassthroughRunner implements TransactionRunner {
  calls = 0;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.calls++;
    return work();
  }
}

describe('ConfirmReservationUseCase', () => {
  let reservations: FakeReservations;
  let transaction: PassthroughRunner;
  let useCase: ConfirmReservationUseCase;

  beforeEach(() => {
    reservations = new FakeReservations();
    transaction = new PassthroughRunner();
    useCase = new ConfirmReservationUseCase(reservations, transaction);
  });

  it('confirms a hold that is still within its TTL', async () => {
    const reservation = await useCase.execute('res-1', NOW);

    expect(reservation.state).toBe('CONFIRMED');
  });

  it('LOCKS the row — that is what excludes the sweeper', async () => {
    await useCase.execute('res-1', NOW);

    expect(reservations.lockedFor).toBe('res-1');
  });

  it('extends the claims, so the seats cannot free themselves mid-payment', async () => {
    await useCase.execute('res-1', NOW);

    expect(reservations.extendedFor).toBe('res-1');
  });

  it('rejects a hold whose TTL has lapsed, even though it still says PENDING', async () => {
    expect(reservations.current!.state).toBe('PENDING');

    await expect(useCase.execute('res-1', AFTER_TTL)).rejects.toThrow(InvalidStateTransition);
  });

  it('does not extend the claims when confirmation fails', async () => {
    await expect(useCase.execute('res-1', AFTER_TTL)).rejects.toThrow();

    expect(reservations.extendedFor).toBeNull();
  });

  it('runs inside a transaction', async () => {
    await useCase.execute('res-1', NOW);

    expect(transaction.calls).toBe(1);
  });

  it('rejects an unknown reservation', async () => {
    reservations.current = null;

    await expect(useCase.execute('res-1', NOW)).rejects.toThrow(ReservationNotFound);
  });
});

describe('ExpireReservationsUseCase', () => {
  it('sweeps a bounded batch, so an outage backlog cannot lock everything at once', async () => {
    const reservations = new FakeReservations();
    const useCase = new ExpireReservationsUseCase(reservations, new PassthroughRunner());

    await useCase.execute();

    expect(reservations.expireLimit).toBe(500);
  });

  it('honours an explicit batch size', async () => {
    const reservations = new FakeReservations();
    const useCase = new ExpireReservationsUseCase(reservations, new PassthroughRunner());

    await useCase.execute(10);

    expect(reservations.expireLimit).toBe(10);
  });

  it('reports how many were expired', async () => {
    const reservations = new FakeReservations();
    reservations.expiredCount = 7;
    const useCase = new ExpireReservationsUseCase(reservations, new PassthroughRunner());

    expect(await useCase.execute()).toBe(7);
  });
});
