import { type EventRepository } from '../domain/inventory-repository.port.js';

export interface ListEventsQuery {
  readonly limit: number;
  readonly offset: number;
  readonly now: Date;
}

/** One event as a list page needs it — no seat counts. See the note below. */
export interface EventSummary {
  readonly id: string;
  readonly name: string;
  readonly startsAt: Date;
  readonly salesOpenAt: Date;
  readonly salesCloseAt: Date;
  readonly onSale: boolean;
}

export interface EventListResult {
  readonly events: readonly EventSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * The events list (TICK-F2).
 *
 * Deliberately carries NO seat counts. `overviewFor` aggregates over every seat
 * of one event; doing that per row would be one aggregate per event on a page —
 * the classic N+1, and the cost grows with the venue rather than the page. The
 * detail page asks for counts for the one event a user actually opened.
 *
 * `onSale` is computed here rather than in the query, for the same reason
 * `GetEventOverviewUseCase` does: the sales window is a rule the aggregate
 * owns, and a second copy of it in SQL is a second thing to get wrong.
 */
export class ListEventsUseCase {
  constructor(private readonly events: EventRepository) {}

  async execute(query: ListEventsQuery): Promise<EventListResult> {
    const page = await this.events.list({ limit: query.limit, offset: query.offset });

    return {
      events: page.events.map((event) => ({
        id: event.id,
        name: event.name,
        startsAt: event.startsAt,
        salesOpenAt: event.salesOpenAt,
        salesCloseAt: event.salesCloseAt,
        onSale: event.isOnSale(query.now),
      })),
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    };
  }
}
