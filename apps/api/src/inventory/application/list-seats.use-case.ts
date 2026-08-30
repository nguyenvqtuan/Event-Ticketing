import { type EventId } from '../domain/event.js';
import {
  type EventRepository,
  type SeatPage,
  type SeatRepository,
  type SeatStatus,
} from '../domain/inventory-repository.port.js';
import { EventNotFound } from './get-event-overview.use-case.js';

export interface ListSeatsQuery {
  readonly eventId: EventId;
  /** `ALL` applies no filter — what a seat map asks for. */
  readonly status: SeatStatus | 'ALL';
  readonly limit: number;
  readonly offset: number;
}

export interface SeatListResult extends SeatPage {
  readonly limit: number;
  readonly offset: number;
}

export class ListSeatsUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly seats: SeatRepository,
  ) {}

  async execute(query: ListSeatsQuery): Promise<SeatListResult> {
    // Distinguish "event does not exist" (404) from "event has no matching
    // seats" (200 with an empty page). Without this check both look identical.
    const event = await this.events.findById(query.eventId);

    if (!event) {
      throw new EventNotFound(query.eventId);
    }

    const page = await this.seats.listByAvailability(query);

    return { ...page, limit: query.limit, offset: query.offset };
  }
}
