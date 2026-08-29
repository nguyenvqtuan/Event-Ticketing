import { InvariantViolation } from '../../shared/domain/domain-error.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { type Event } from '../domain/event.js';
import { type EventRepository, type SeatRepository } from '../domain/inventory-repository.port.js';
import { type SeatBlueprint } from '../domain/seat-map.js';
import { CreateEventUseCase } from './create-event.use-case.js';

/**
 * Plain fakes, no Nest, no database — the payoff of keeping use cases
 * undecorated and dependent on ports.
 */
class FakeEventRepository implements EventRepository {
  saved: Event[] = [];
  save(event: Event) {
    this.saved.push(event);
    return Promise.resolve();
  }
  findById() {
    return Promise.resolve(null);
  }
}

class FakeSeatRepository implements SeatRepository {
  lastBlueprints: readonly SeatBlueprint[] = [];
  createdCount = 0;

  createMany(_eventId: string, blueprints: readonly SeatBlueprint[]) {
    this.lastBlueprints = blueprints;
    return Promise.resolve(this.createdCount);
  }
  overviewFor() {
    return Promise.resolve({ total: 0, available: 0, held: 0, sold: 0 });
  }
  listByAvailability() {
    return Promise.resolve({ seats: [], total: 0 });
  }
  lockAndCheckAvailability() {
    return Promise.resolve({ missing: [], unavailable: [] });
  }
}

/** Records whether the work ran inside a transaction boundary. */
class RecordingTransactionRunner implements TransactionRunner {
  ran = false;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.ran = true;
    return work();
  }
}

const command = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Cup Final',
  startsAt: new Date('2026-06-01T19:00:00.000Z'),
  salesOpenAt: new Date('2026-01-01T00:00:00.000Z'),
  salesCloseAt: new Date('2026-06-01T00:00:00.000Z'),
  rows: 3,
  seatsPerRow: 10,
  priceMinor: 5_000,
  currency: 'GBP',
  ...overrides,
});

describe('CreateEventUseCase', () => {
  let events: FakeEventRepository;
  let seats: FakeSeatRepository;
  let transaction: RecordingTransactionRunner;
  let useCase: CreateEventUseCase;

  beforeEach(() => {
    events = new FakeEventRepository();
    seats = new FakeSeatRepository();
    transaction = new RecordingTransactionRunner();
    useCase = new CreateEventUseCase(events, seats, transaction);
  });

  it('saves the event and generates its seats', async () => {
    seats.createdCount = 30;

    const result = await useCase.execute(command());

    expect(events.saved).toHaveLength(1);
    expect(seats.lastBlueprints).toHaveLength(30);
    expect(result).toEqual({
      eventId: '11111111-1111-1111-1111-111111111111',
      seatsCreated: 30,
      totalSeats: 30,
    });
  });

  it('does both inside one transaction — an event without seats is not valid', async () => {
    await useCase.execute(command());

    expect(transaction.ran).toBe(true);
  });

  it('reports seatsCreated separately from totalSeats, so a retry is visible', async () => {
    // Second call: the unique index absorbed every insert.
    seats.createdCount = 0;

    const result = await useCase.execute(command());

    expect(result.seatsCreated).toBe(0);
    expect(result.totalSeats).toBe(30);
  });

  describe('validates before opening a transaction', () => {
    it('rejects sales closing after the event starts', async () => {
      await expect(
        useCase.execute(command({ salesCloseAt: new Date('2026-06-02T00:00:00.000Z') })),
      ).rejects.toThrow(InvariantViolation);

      expect(transaction.ran).toBe(false);
      expect(events.saved).toHaveLength(0);
    });

    it('rejects an impossible seat map', async () => {
      await expect(useCase.execute(command({ rows: 0 }))).rejects.toThrow(InvariantViolation);

      expect(transaction.ran).toBe(false);
    });

    it('rejects a blank name', async () => {
      await expect(useCase.execute(command({ name: '   ' }))).rejects.toThrow(InvariantViolation);

      expect(transaction.ran).toBe(false);
    });
  });
});
