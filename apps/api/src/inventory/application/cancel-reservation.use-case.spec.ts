import { InvalidStateTransition } from '../../shared/domain/domain-error.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { Reservation } from '../domain/reservation.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';
import { CancelReservationUseCase, ReservationNotFound } from './cancel-reservation.use-case.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const TTL = 900;

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
  updated: Reservation[] = [];

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
  updateState(reservation: Reservation) {
    this.updated.push(reservation);
    return Promise.resolve();
  }
  extendClaimsIndefinitely() {
    return Promise.resolve();
  }
  pricedSeatsFor() {
    return Promise.resolve([]);
  }
  markClaimsSold() {
    return Promise.resolve();
  }
  releaseClaims() {
    return Promise.resolve();
  }
  expireLapsed() {
    return Promise.resolve(0);
  }
}

class PassthroughRunner implements TransactionRunner {
  calls = 0;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.calls++;
    return work();
  }
}

describe('CancelReservationUseCase', () => {
  let reservations: FakeReservations;
  let transaction: PassthroughRunner;
  let useCase: CancelReservationUseCase;

  beforeEach(() => {
    reservations = new FakeReservations();
    transaction = new PassthroughRunner();
    useCase = new CancelReservationUseCase(reservations, transaction);
  });

  it('cancels a pending hold and persists the new state', async () => {
    const reservation = await useCase.execute('res-1');

    expect(reservation.state).toBe('CANCELLED');
    expect(reservations.updated).toEqual([reservation]);
  });

  it('does NOT lock the row — cancelling is the uncontended path', async () => {
    await useCase.execute('res-1');

    // Only the holder cancels their own hold, so this asserts the version it
    // read instead of taxing every request with a lock. See docs/concurrency.md.
    expect(reservations.lockedFor).toBeNull();
  });

  it('runs inside a transaction', async () => {
    await useCase.execute('res-1');

    expect(transaction.calls).toBe(1);
  });

  it('lets the aggregate refuse a hold that is already confirmed', async () => {
    reservations.current!.confirm(NOW);

    await expect(useCase.execute('res-1')).rejects.toThrow(InvalidStateTransition);
    expect(reservations.updated).toHaveLength(0);
  });

  it('rejects an unknown reservation', async () => {
    reservations.current = null;

    await expect(useCase.execute('res-1')).rejects.toThrow(ReservationNotFound);
  });
});
