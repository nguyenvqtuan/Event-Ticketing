import { DomainError } from '../../shared/domain/domain-error.js';
import { type EventId } from '../domain/event.js';
import {
  type EventRepository,
  type SeatOverview,
  type SeatRepository,
} from '../domain/inventory-repository.port.js';

/** Thrown when a requested aggregate does not exist. Mapped to 404 at the edge. */
export class EventNotFound extends DomainError {
  constructor(id: EventId) {
    super(`Event ${id} not found`);
  }
}

export interface EventOverview {
  readonly id: EventId;
  readonly name: string;
  readonly startsAt: Date;
  readonly salesOpenAt: Date;
  readonly salesCloseAt: Date;
  readonly onSale: boolean;
  readonly seats: SeatOverview;
}

export class GetEventOverviewUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly seats: SeatRepository,
  ) {}

  async execute(id: EventId, now: Date): Promise<EventOverview> {
    const event = await this.events.findById(id);

    if (!event) {
      throw new EventNotFound(id);
    }

    const seats = await this.seats.overviewFor(id);

    return {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      salesOpenAt: event.salesOpenAt,
      salesCloseAt: event.salesCloseAt,
      // The sales-window rule lives in the aggregate, not in this query.
      onSale: event.isOnSale(now),
      seats,
    };
  }
}
