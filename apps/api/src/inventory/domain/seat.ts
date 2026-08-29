import { InvariantViolation } from '../../shared/domain/domain-error.js';
import { type Money } from '../../shared/domain/money.js';
import { type EventId } from './event.js';

export type SeatId = string;

/**
 * A seat in an event's catalogue.
 *
 * Deliberately has NO status field. Whether a seat is held or sold is derived
 * from whether an active claim references it — see docs/domain.md. Carrying a
 * status here would mean writing it and the reservation in the same breath,
 * and any missed write silently double-books the seat or strands it forever.
 *
 * Seats are effectively immutable once an event is published.
 */
export class Seat {
  private constructor(
    readonly id: SeatId,
    readonly eventId: EventId,
    readonly code: string,
    readonly price: Money,
  ) {}

  static create(params: { id: SeatId; eventId: EventId; code: string; price: Money }): Seat {
    const { id, eventId, code, price } = params;

    if (!code.trim()) {
      throw new InvariantViolation('Seat requires a code');
    }
    if (price.amountMinor < 0) {
      throw new InvariantViolation(`Seat price cannot be negative: ${price.toString()}`);
    }

    return new Seat(id, eventId, code, price);
  }
}

/**
 * The states a seat can be observed in. This is a *derived* view, computed by
 * a query joining active claims — never a stored column.
 */
export type SeatAvailability = 'AVAILABLE' | 'HELD' | 'SOLD';
