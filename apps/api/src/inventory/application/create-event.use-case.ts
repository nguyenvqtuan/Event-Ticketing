import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { Money } from '../../shared/domain/money.js';
import { Event } from '../domain/event.js';
import { type EventRepository, type SeatRepository } from '../domain/inventory-repository.port.js';
import { generateSeatMap } from '../domain/seat-map.js';

export interface CreateEventCommand {
  readonly id: string;
  readonly name: string;
  readonly startsAt: Date;
  readonly salesOpenAt: Date;
  readonly salesCloseAt: Date;
  readonly rows: number;
  readonly seatsPerRow: number;
  readonly priceMinor: number;
  readonly currency: string;
}

export interface CreateEventResult {
  readonly eventId: string;
  readonly seatsCreated: number;
  readonly totalSeats: number;
}

/**
 * Creates an event and its seat inventory atomically.
 *
 * Framework-free: no `@Injectable()`, no HTTP, no SQL. It is constructed by a
 * `useFactory` in inventory.module.ts, which is what keeps it unit-testable
 * with plain fakes.
 */
export class CreateEventUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly seats: SeatRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  async execute(command: CreateEventCommand): Promise<CreateEventResult> {
    // Validate before opening a transaction: a bad spec should not hold locks
    // while it fails. Both constructors throw on invariant violations.
    const event = Event.schedule({
      id: command.id,
      name: command.name,
      startsAt: command.startsAt,
      salesOpenAt: command.salesOpenAt,
      salesCloseAt: command.salesCloseAt,
    });

    const blueprints = generateSeatMap({
      rows: command.rows,
      seatsPerRow: command.seatsPerRow,
      price: Money.of(command.priceMinor, command.currency),
    });

    // One transaction: an event without its seats is not a valid outcome.
    return this.transaction.run(async () => {
      await this.events.save(event);
      const seatsCreated = await this.seats.createMany(event.id, blueprints);

      return { eventId: event.id, seatsCreated, totalSeats: blueprints.length };
    });
  }
}
