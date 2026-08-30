import { Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DatabaseContext } from '../../shared/infrastructure/database/database.module.js';
import { events } from '../../shared/infrastructure/database/schema.js';
import { Event, type EventId } from '../domain/event.js';
import { type EventPage, type EventRepository } from '../domain/inventory-repository.port.js';

/**
 * Maps the Event aggregate to rows and back. Mapping only — no decisions.
 * Every rule lives in `Event`, which this file reconstitutes through the same
 * factory the rest of the system uses, so a row that violates an invariant
 * fails loudly here rather than spreading.
 */
@Injectable()
export class DrizzleEventRepository implements EventRepository {
  constructor(private readonly context: DatabaseContext) {}

  async save(event: Event): Promise<void> {
    await this.context.db
      .insert(events)
      .values({
        id: event.id,
        name: event.name,
        startsAt: event.startsAt,
        salesOpenAt: event.salesOpenAt,
        salesCloseAt: event.salesCloseAt,
      })
      .onConflictDoNothing({ target: events.id });
  }

  async list(params: { limit: number; offset: number }): Promise<EventPage> {
    const rows = await this.context.db
      .select()
      .from(events)
      // `id` breaks ties: `starts_at` alone is not a total order, and an
      // unstable sort under LIMIT/OFFSET drops and repeats rows across pages.
      .orderBy(asc(events.startsAt), asc(events.id))
      .limit(params.limit)
      .offset(params.offset);

    const [counted] = await this.context.db
      .select({ total: sql<number>`count(*)::int` })
      .from(events);

    return {
      // Through the same factory as findById, so a row that violates an
      // invariant fails here rather than spreading into a list page.
      events: rows.map((row) =>
        Event.schedule({
          id: row.id,
          name: row.name,
          startsAt: row.startsAt,
          salesOpenAt: row.salesOpenAt,
          salesCloseAt: row.salesCloseAt,
        }),
      ),
      total: counted?.total ?? 0,
    };
  }

  async findById(id: EventId): Promise<Event | null> {
    const [row] = await this.context.db.select().from(events).where(eq(events.id, id)).limit(1);

    if (!row) return null;

    return Event.schedule({
      id: row.id,
      name: row.name,
      startsAt: row.startsAt,
      salesOpenAt: row.salesOpenAt,
      salesCloseAt: row.salesCloseAt,
    });
  }
}
