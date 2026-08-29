import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseContext } from '../../shared/infrastructure/database/database.module.js';
import { seats } from '../../shared/infrastructure/database/schema.js';
import { type EventId } from '../domain/event.js';
import {
  type SeatOverview,
  type SeatPage,
  type SeatRepository,
  type StoredSeat,
} from '../domain/inventory-repository.port.js';
import { type SeatBlueprint } from '../domain/seat-map.js';

/**
 * Availability is derived, never stored (see docs/domain.md), so every query
 * here asks the same question: does a live claim cover this seat right now?
 *
 *   live claim  =  claim_state <> 'RELEASED' AND valid_during @> now()
 *
 * A HELD claim's range ends at its TTL, so a lapsed hold stops counting with
 * no sweeper having run. That is the whole point of the range model.
 */
const LIVE_CLAIM = sql`
  SELECT 1 FROM reservation_items ri
  WHERE ri.seat_id = ${seats.id}
    AND ri.claim_state <> 'RELEASED'
    AND ri.valid_during @> now()
`;

const SOLD_CLAIM = sql`
  SELECT 1 FROM reservation_items ri
  WHERE ri.seat_id = ${seats.id}
    AND ri.claim_state = 'SOLD'
    AND ri.valid_during @> now()
`;

@Injectable()
export class DrizzleSeatRepository implements SeatRepository {
  constructor(private readonly context: DatabaseContext) {}

  /**
   * Idempotent by construction: the unique index on (event_id, code) decides,
   * not a prior read. Two concurrent generations both succeed and converge on
   * the same seat set instead of racing.
   */
  async createMany(eventId: EventId, blueprints: readonly SeatBlueprint[]): Promise<number> {
    if (blueprints.length === 0) return 0;

    let created = 0;

    // Chunked so a large map does not build one enormous statement.
    const CHUNK = 5_000;
    for (let start = 0; start < blueprints.length; start += CHUNK) {
      const chunk = blueprints.slice(start, start + CHUNK);

      const inserted = await this.context.db
        .insert(seats)
        .values(
          chunk.map((seat) => ({
            eventId,
            code: seat.code,
            priceMinor: seat.price.amountMinor,
            currency: seat.price.currency,
          })),
        )
        .onConflictDoNothing({ target: [seats.eventId, seats.code] })
        .returning({ id: seats.id });

      created += inserted.length;
    }

    return created;
  }

  async overviewFor(eventId: EventId): Promise<SeatOverview> {
    const [row] = await this.context.db
      .select({
        total: sql<number>`count(*)::int`,
        sold: sql<number>`count(*) FILTER (WHERE EXISTS (${SOLD_CLAIM}))::int`,
        live: sql<number>`count(*) FILTER (WHERE EXISTS (${LIVE_CLAIM}))::int`,
      })
      .from(seats)
      .where(eq(seats.eventId, eventId));

    const total = row?.total ?? 0;
    const sold = row?.sold ?? 0;
    const live = row?.live ?? 0;

    // HELD is "claimed but not sold" — the two categories cannot overlap,
    // because the exclusion constraint forbids two live claims on one seat.
    return { total, sold, held: live - sold, available: total - live };
  }

  async listByAvailability(params: {
    eventId: EventId;
    status: 'AVAILABLE' | 'HELD' | 'SOLD';
    limit: number;
    offset: number;
  }): Promise<SeatPage> {
    const { eventId, status, limit, offset } = params;

    const predicate =
      status === 'AVAILABLE'
        ? sql`NOT EXISTS (${LIVE_CLAIM})`
        : status === 'SOLD'
          ? sql`EXISTS (${SOLD_CLAIM})`
          : sql`EXISTS (${LIVE_CLAIM}) AND NOT EXISTS (${SOLD_CLAIM})`;

    const where = and(eq(seats.eventId, eventId), predicate);

    const rows = await this.context.db
      .select({
        id: seats.id,
        code: seats.code,
        priceMinor: seats.priceMinor,
        currency: seats.currency,
      })
      .from(seats)
      .where(where)
      .orderBy(seats.code)
      .limit(limit)
      .offset(offset);

    const [counted] = await this.context.db
      .select({ total: sql<number>`count(*)::int` })
      .from(seats)
      .where(where);

    return {
      seats: rows as StoredSeat[],
      total: counted?.total ?? 0,
    };
  }
}
