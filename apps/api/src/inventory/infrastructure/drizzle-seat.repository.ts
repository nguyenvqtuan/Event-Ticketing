import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseContext } from '../../shared/infrastructure/database/database.module.js';
import { seats } from '../../shared/infrastructure/database/schema.js';
import { type EventId } from '../domain/event.js';
import {
  type SeatAvailability,
  type SeatOverview,
  type SeatPage,
  type SeatRepository,
  type SeatStatus,
  type StoredSeat,
} from '../domain/inventory-repository.port.js';
import { type SeatId } from '../domain/seat.js';
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
    status: SeatStatus | 'ALL';
    limit: number;
    offset: number;
  }): Promise<SeatPage> {
    const { eventId, status, limit, offset } = params;

    const predicate =
      status === 'ALL'
        ? undefined
        : status === 'AVAILABLE'
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
        // Derived in the SAME query as the filter, so every seat's status is
        // read at one instant from one clock. SOLD is checked first because a
        // sold seat also has a live claim — the order is the definition.
        status: sql<SeatStatus>`
          CASE
            WHEN EXISTS (${SOLD_CLAIM}) THEN 'SOLD'
            WHEN EXISTS (${LIVE_CLAIM}) THEN 'HELD'
            ELSE 'AVAILABLE'
          END
        `,
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

  /**
   * Locks the seat rows, then reports which cannot be held.
   *
   * `ORDER BY id ... FOR UPDATE` is doing two jobs:
   *
   *   FOR UPDATE — competing transactions block here rather than racing to
   *   write. Under READ COMMITTED the waiter re-reads the newest committed row
   *   once the lock is granted, so it sees the winner's claim and can report a
   *   clean conflict. See docs/concurrency.md.
   *
   *   ORDER BY id — a deterministic lock order. Two multi-seat holds that
   *   overlap (A,B and B,A) would otherwise each hold what the other wants and
   *   deadlock; ordering makes that impossible.
   *
   * Locks `seats` rather than `reservation_items` because the row being
   * contended for must already exist — there is no claim row to lock until
   * someone creates one, which is the race itself.
   */
  async lockAndCheckAvailability(
    eventId: EventId,
    seatIds: readonly SeatId[],
  ): Promise<SeatAvailability> {
    if (seatIds.length === 0) {
      return { missing: [], unavailable: [] };
    }

    const requested = [...new Set(seatIds)];

    const locked = await this.context.db
      .select({ id: seats.id })
      .from(seats)
      .where(and(eq(seats.eventId, eventId), inArray(seats.id, requested)))
      .orderBy(seats.id)
      .for('update');

    const found = new Set(locked.map((row) => row.id));
    const missing = requested.filter((id) => !found.has(id));

    if (found.size === 0) {
      return { missing, unavailable: [] };
    }

    // Safe to read now: every seat that exists is locked, so no concurrent
    // transaction can add a claim for one of them until this one commits.
    const claimed = await this.context.db.execute<{ seat_id: string }>(sql`
      SELECT ri.seat_id
      FROM reservation_items ri
      WHERE ri.seat_id IN (${sql.join(
        [...found].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND ri.claim_state <> 'RELEASED'
        AND ri.valid_during @> now()
    `);

    return {
      missing,
      unavailable: claimed.rows.map((row) => row.seat_id),
    };
  }
}
