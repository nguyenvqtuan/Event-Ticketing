import { InvariantViolation } from '../../shared/domain/domain-error.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { Event } from '../domain/event.js';
import {
  type EventRepository,
  type SeatAvailability,
  type SeatRepository,
} from '../domain/inventory-repository.port.js';
import { type Reservation } from '../domain/reservation.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';
import { EventNotFound } from './get-event-overview.use-case.js';
import { HoldSeatsUseCase, SalesClosed, SeatsUnavailable } from './hold-seats.use-case.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');

const onSaleEvent = Event.schedule({
  id: 'evt-1',
  name: 'Cup Final',
  startsAt: new Date('2026-06-01T19:00:00.000Z'),
  salesOpenAt: new Date('2026-01-01T00:00:00.000Z'),
  salesCloseAt: new Date('2026-06-01T00:00:00.000Z'),
});

class FakeEvents implements EventRepository {
  event: Event | null = onSaleEvent;
  save() {
    return Promise.resolve();
  }
  findById() {
    return Promise.resolve(this.event);
  }
}

class FakeSeats implements SeatRepository {
  availability: SeatAvailability = { missing: [], unavailable: [] };
  lockedWith: readonly string[] = [];

  lockAndCheckAvailability(_eventId: string, seatIds: readonly string[]) {
    this.lockedWith = seatIds;
    return Promise.resolve(this.availability);
  }
  createMany() {
    return Promise.resolve(0);
  }
  overviewFor() {
    return Promise.resolve({ total: 0, available: 0, held: 0, sold: 0 });
  }
  listByAvailability() {
    return Promise.resolve({ seats: [], total: 0 });
  }
}

class FakeReservations implements ReservationRepository {
  saved: Reservation[] = [];
  save(reservation: Reservation) {
    this.saved.push(reservation);
    return Promise.resolve();
  }
  findById() {
    return Promise.resolve(null);
  }
  updateState() {
    return Promise.resolve();
  }
  expireLapsed() {
    return Promise.resolve(0);
  }
  findByIdForUpdate() {
    return Promise.resolve(null);
  }
  extendClaimsIndefinitely() {
    return Promise.resolve();
  }
}

class RecordingRunner implements TransactionRunner {
  ran = false;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.ran = true;
    return work();
  }
}

describe('HoldSeatsUseCase', () => {
  let events: FakeEvents;
  let seats: FakeSeats;
  let reservations: FakeReservations;
  let transaction: RecordingRunner;
  let useCase: HoldSeatsUseCase;

  const command = (overrides: Record<string, unknown> = {}) => ({
    id: 'res-1',
    eventId: 'evt-1',
    holderId: 'holder-1',
    seatIds: ['seat-1', 'seat-2'],
    now: NOW,
    ttlSeconds: 900,
    ...overrides,
  });

  beforeEach(() => {
    events = new FakeEvents();
    seats = new FakeSeats();
    reservations = new FakeReservations();
    transaction = new RecordingRunner();
    useCase = new HoldSeatsUseCase(events, seats, reservations, transaction);
  });

  it('holds the seats and persists the reservation', async () => {
    const reservation = await useCase.execute(command());

    expect(reservation.state).toBe('PENDING');
    expect(reservation.seatIds).toEqual(['seat-1', 'seat-2']);
    expect(reservations.saved).toHaveLength(1);
  });

  it('expires exactly ttlSeconds after now', async () => {
    const reservation = await useCase.execute(command());

    expect(reservation.expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
  });

  it('does everything inside one transaction', async () => {
    await useCase.execute(command());

    expect(transaction.ran).toBe(true);
  });

  it('locks the seats before deciding — the lock is what makes the check sound', async () => {
    await useCase.execute(command());

    expect(seats.lockedWith).toEqual(['seat-1', 'seat-2']);
  });

  describe('all-or-nothing', () => {
    it('saves nothing when one seat is unavailable', async () => {
      seats.availability = { missing: [], unavailable: ['seat-2'] };

      await expect(useCase.execute(command())).rejects.toThrow(SeatsUnavailable);
      expect(reservations.saved).toHaveLength(0);
    });

    it('reports which seats were lost, so a caller can retry with the rest', async () => {
      seats.availability = { missing: [], unavailable: ['seat-2'] };

      await expect(useCase.execute(command())).rejects.toMatchObject({
        unavailable: ['seat-2'],
      });
    });

    it('distinguishes unknown seats from taken ones', async () => {
      seats.availability = { missing: ['seat-9'], unavailable: [] };

      await expect(useCase.execute(command())).rejects.toMatchObject({
        missing: ['seat-9'],
      });
    });
  });

  describe('guards', () => {
    it('rejects an unknown event', async () => {
      events.event = null;

      await expect(useCase.execute(command())).rejects.toThrow(EventNotFound);
    });

    it('rejects a hold when sales are not open', async () => {
      await expect(
        useCase.execute(command({ now: new Date('2025-01-01T00:00:00.000Z') })),
      ).rejects.toThrow(SalesClosed);

      expect(reservations.saved).toHaveLength(0);
    });

    it('rejects an empty seat list via the aggregate', async () => {
      await expect(useCase.execute(command({ seatIds: [] }))).rejects.toThrow(InvariantViolation);
    });

    it('rejects duplicate seats via the aggregate', async () => {
      await expect(useCase.execute(command({ seatIds: ['seat-1', 'seat-1'] }))).rejects.toThrow(
        /same seat twice/,
      );
    });
  });
});
