import { Event } from '../domain/event.js';
import { type EventPage, type EventRepository } from '../domain/inventory-repository.port.js';
import { ListEventsUseCase } from './list-events.use-case.js';

/**
 * No database in sight, like the other use-case tests. What is worth asserting
 * is the decision this makes — `onSale` against a given clock — not that a
 * repository was called.
 */
const NOW = new Date('2026-03-01T12:00:00.000Z');

const eventAt = (id: string, starts: string, opens: string, closes: string) =>
  Event.schedule({
    id,
    name: `Event ${id}`,
    startsAt: new Date(starts),
    salesOpenAt: new Date(opens),
    salesCloseAt: new Date(closes),
  });

/** Sales open in the past, closing well after NOW. */
const onSale = eventAt(
  'evt-open',
  '2026-06-01T19:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  '2026-05-01T00:00:00.000Z',
);

/** Sales have not opened yet at NOW. */
const notYetOnSale = eventAt(
  'evt-future',
  '2026-09-01T19:00:00.000Z',
  '2026-08-01T00:00:00.000Z',
  '2026-08-30T00:00:00.000Z',
);

class FakeEvents implements EventRepository {
  page: EventPage = { events: [onSale, notYetOnSale], total: 2 };
  askedFor?: { limit: number; offset: number };

  save() {
    return Promise.resolve();
  }
  findById() {
    return Promise.resolve(null);
  }
  list(params: { limit: number; offset: number }) {
    this.askedFor = params;
    return Promise.resolve(this.page);
  }
}

describe('ListEventsUseCase', () => {
  it('reports each event as on sale or not, against the clock it is given', async () => {
    const result = await new ListEventsUseCase(new FakeEvents()).execute({
      limit: 20,
      offset: 0,
      now: NOW,
    });

    expect(result.events.map((e) => [e.id, e.onSale])).toEqual([
      ['evt-open', true],
      ['evt-future', false],
    ]);
  });

  it('takes the clock as an argument rather than reading it', async () => {
    // The same repository, a later clock: sales for the second event have
    // opened by now. A use case that called `new Date()` could not be asked
    // this question at all.
    const result = await new ListEventsUseCase(new FakeEvents()).execute({
      limit: 20,
      offset: 0,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(result.events.map((e) => e.onSale)).toEqual([false, true]);
  });

  it('passes the paging through and echoes it back', async () => {
    const events = new FakeEvents();

    const result = await new ListEventsUseCase(events).execute({
      limit: 5,
      offset: 10,
      now: NOW,
    });

    expect(events.askedFor).toEqual({ limit: 5, offset: 10 });
    // Echoed so a caller can page without restating what it asked for.
    expect({ limit: result.limit, offset: result.offset, total: result.total }).toEqual({
      limit: 5,
      offset: 10,
      total: 2,
    });
  });

  it('returns an empty page rather than failing when there are no events', async () => {
    const events = new FakeEvents();
    events.page = { events: [], total: 0 };

    const result = await new ListEventsUseCase(events).execute({ limit: 20, offset: 0, now: NOW });

    // An empty collection is a valid answer — unlike a missing event, which is
    // a 404. The list page renders an empty state from this.
    expect(result.events).toEqual([]);
    expect(result.total).toBe(0);
  });
});
