import { Event } from '../domain/event.js';
import {
  type EventRepository,
  type SeatOverview,
  type SeatPage,
  type SeatRepository,
} from '../domain/inventory-repository.port.js';
import { EventNotFound, GetEventOverviewUseCase } from './get-event-overview.use-case.js';
import { ListSeatsUseCase } from './list-seats.use-case.js';

/**
 * The two read paths. Neither has a database in sight: both are orchestration
 * over ports, and what is worth asserting is the decision each makes — not
 * that a repository was called.
 */
const NOW = new Date('2026-03-01T12:00:00.000Z');

const event = Event.schedule({
  id: 'evt-1',
  name: 'Cup Final',
  startsAt: new Date('2026-06-01T19:00:00.000Z'),
  salesOpenAt: new Date('2026-01-01T00:00:00.000Z'),
  salesCloseAt: new Date('2026-06-01T00:00:00.000Z'),
});

class FakeEvents implements EventRepository {
  event: Event | null = event;
  save() {
    return Promise.resolve();
  }
  findById() {
    return Promise.resolve(this.event);
  }
  list() {
    return Promise.resolve({ events: this.event ? [this.event] : [], total: this.event ? 1 : 0 });
  }
}

class FakeSeats implements SeatRepository {
  overview: SeatOverview = { total: 100, available: 60, held: 10, sold: 30 };
  page: SeatPage = { seats: [], total: 0 };
  askedFor?: Record<string, unknown>;

  createMany() {
    return Promise.resolve(0);
  }
  overviewFor() {
    return Promise.resolve(this.overview);
  }
  listByAvailability(params: Record<string, unknown>) {
    this.askedFor = params;
    return Promise.resolve(this.page);
  }
  lockAndCheckAvailability() {
    return Promise.resolve({ missing: [], unavailable: [] });
  }
}

describe('GetEventOverviewUseCase', () => {
  it('returns the event with its derived seat counts', async () => {
    const seats = new FakeSeats();
    const overview = await new GetEventOverviewUseCase(new FakeEvents(), seats).execute(
      'evt-1',
      NOW,
    );

    expect(overview.name).toBe('Cup Final');
    expect(overview.seats).toEqual({ total: 100, available: 60, held: 10, sold: 30 });
  });

  it('asks the aggregate whether sales are open rather than deciding itself', async () => {
    const useCase = new GetEventOverviewUseCase(new FakeEvents(), new FakeSeats());

    expect((await useCase.execute('evt-1', NOW)).onSale).toBe(true);
    // Past the close date the same aggregate says no, with no branch here.
    expect((await useCase.execute('evt-1', new Date('2026-06-02T00:00:00.000Z'))).onSale).toBe(
      false,
    );
  });

  it('reports a missing event rather than an empty one', async () => {
    const events = new FakeEvents();
    events.event = null;

    await expect(
      new GetEventOverviewUseCase(events, new FakeSeats()).execute('evt-nope', NOW),
    ).rejects.toThrow(EventNotFound);
  });
});

describe('ListSeatsUseCase', () => {
  const query = {
    eventId: 'evt-1',
    status: 'AVAILABLE' as const,
    limit: 50,
    offset: 100,
  };

  it('returns the page with the paging it was asked for', async () => {
    const seats = new FakeSeats();
    seats.page = {
      seats: [
        { id: 'seat-1', code: 'A1', priceMinor: 5_000, currency: 'GBP', status: 'AVAILABLE' },
      ],
      total: 1,
    };

    const result = await new ListSeatsUseCase(new FakeEvents(), seats).execute(query);

    expect(result.total).toBe(1);
    expect(result.seats).toHaveLength(1);
    // Echoed back so a client can page without re-deriving where it was.
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(100);
    expect(seats.askedFor).toMatchObject({ eventId: 'evt-1', status: 'AVAILABLE' });
  });

  it('distinguishes a missing event from an event with no matching seats', async () => {
    const events = new FakeEvents();

    // No matching seats: a legitimate empty page, not an error.
    await expect(
      new ListSeatsUseCase(events, new FakeSeats()).execute(query),
    ).resolves.toMatchObject({ seats: [], total: 0 });

    events.event = null;
    await expect(new ListSeatsUseCase(events, new FakeSeats()).execute(query)).rejects.toThrow(
      EventNotFound,
    );
  });
});
