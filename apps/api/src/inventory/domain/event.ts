import { InvariantViolation } from '../../shared/domain/domain-error.js';

export type EventId = string;

/**
 * Aggregate root: an event that tickets are sold for.
 *
 * Owns only its own identity and sales window. It deliberately does NOT hold
 * a collection of seats — an arena event has tens of thousands, and loading
 * them to answer "are sales open?" would make the aggregate useless. Seats
 * reference the event by id instead.
 */
export class Event {
  private constructor(
    readonly id: EventId,
    readonly name: string,
    readonly startsAt: Date,
    readonly salesOpenAt: Date,
    readonly salesCloseAt: Date,
  ) {}

  static schedule(params: {
    id: EventId;
    name: string;
    startsAt: Date;
    salesOpenAt: Date;
    salesCloseAt: Date;
  }): Event {
    const { id, name, startsAt, salesOpenAt, salesCloseAt } = params;

    if (!name.trim()) {
      throw new InvariantViolation('Event requires a name');
    }
    if (salesCloseAt <= salesOpenAt) {
      throw new InvariantViolation('Sales must close after they open');
    }
    if (salesCloseAt > startsAt) {
      throw new InvariantViolation('Sales must close no later than the event start');
    }

    return new Event(id, name, startsAt, salesOpenAt, salesCloseAt);
  }

  /**
   * Time is passed in rather than read from a clock, so the domain has no
   * hidden dependency and every rule is trivially testable.
   */
  isOnSale(now: Date): boolean {
    return now >= this.salesOpenAt && now < this.salesCloseAt;
  }
}
