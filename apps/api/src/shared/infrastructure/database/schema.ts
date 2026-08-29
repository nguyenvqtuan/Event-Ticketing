import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Postgres range type, which drizzle has no built-in column for.
 *
 * Declaring it here rather than leaving the column as `text` matters: without
 * it, the schema and the database disagree, and the next `db:generate` would
 * happily emit a migration converting the column back to text — destroying
 * the exclusion constraint that depends on it.
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => 'tstzrange',
});

/**
 * Persistence schema. This is INFRASTRUCTURE, not the domain.
 *
 * The domain classes in src/{inventory,payment}/domain are plain TypeScript
 * and know nothing about these tables. Repositories map between the two.
 * Nothing here is imported by a domain or application file.
 *
 * See docs/db.md for the ERD and the no-downtime migration strategy.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------------------
// Ticketing / Inventory
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    salesOpenAt: timestamp('sales_open_at', { withTimezone: true }).notNull(),
    salesCloseAt: timestamp('sales_close_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    // Mirrors Event.schedule()'s invariants, so a bad row cannot be written
    // even by a migration or a psql session that bypasses the domain.
    check('events_sales_window', sql`${table.salesCloseAt} > ${table.salesOpenAt}`),
    check('events_sales_close_before_start', sql`${table.salesCloseAt} <= ${table.startsAt}`),
    check('events_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    // No index on the sales window: TICK-6 measured it at zero scans. With a
    // realistic number of events the planner seq-scans this table anyway.
  ],
);

export const seats = pgTable(
  'seats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    ...timestamps,
  },
  (table) => [
    // "Seat code unique within the event" — the domain cannot enforce this,
    // since it spans every seat of an event.
    uniqueIndex('seats_event_code_uq').on(table.eventId, table.code),
    check('seats_price_non_negative', sql`${table.priceMinor} >= 0`),
    check('seats_code_not_blank', sql`length(btrim(${table.code})) > 0`),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    holderId: uuid('holder_id').notNull(),
    state: text('state').notNull().default('PENDING'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Optimistic concurrency (TICK-9). Every state change asserts the version
    // it read and bumps it, so a lost update becomes a rejected update.
    version: integer('version').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    check(
      'reservations_state_valid',
      sql`${table.state} IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')`,
    ),
    check('reservations_ttl_positive', sql`${table.expiresAt} > ${table.createdAt}`),
    // Sweeper query: find PENDING holds past their TTL.
    index('reservations_pending_expiry_idx')
      .on(table.expiresAt)
      .where(sql`state = 'PENDING'`),
    index('reservations_holder_idx').on(table.holderId, table.createdAt),
  ],
);

/**
 * A claim on one seat. THIS is the table that prevents double-booking.
 *
 * `validDuring` is the claim's lifetime:
 *   HELD  → [created_at, expires_at)   — ends by itself when the TTL lapses
 *   SOLD  → [created_at, 'infinity')   — never ends
 *
 * The exclusion constraint that enforces exclusivity is added by hand in the
 * migration; see docs/db.md for why a unique partial index cannot express it.
 */
export const reservationItems = pgTable(
  'reservation_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    seatId: uuid('seat_id')
      .notNull()
      .references(() => seats.id, { onDelete: 'restrict' }),
    claimState: text('claim_state').notNull().default('HELD'),
    // The claim's lifetime. HELD → [created_at, expires_at); SOLD → [.., infinity).
    // The exclusion constraint over this column is added by hand in the migration.
    validDuring: tstzrange('valid_during').notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      'reservation_items_claim_state_valid',
      sql`${table.claimState} IN ('HELD','SOLD','RELEASED')`,
    ),
    // A reservation cannot list the same seat twice (domain enforces this too).
    uniqueIndex('reservation_items_reservation_seat_uq').on(table.reservationId, table.seatId),
    index('reservation_items_seat_idx').on(table.seatId),
  ],
);

// ---------------------------------------------------------------------------
// Payment / Ledger
// ---------------------------------------------------------------------------

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // One order per reservation: re-submitting checkout must not create two.
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'restrict' }),
    state: text('state').notNull().default('PENDING'),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    failureReason: text('failure_reason'),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    // Same optimistic scheme as reservations; exercised when checkout lands.
    version: integer('version').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('orders_reservation_uq').on(table.reservationId),
    check('orders_state_valid', sql`${table.state} IN ('PENDING','PAID','FAILED','REFUNDED')`),
    check('orders_total_non_negative', sql`${table.totalMinor} >= 0`),
    // Mirrors Order.markFailed(): a FAILED order must say why, and only a
    // FAILED order may carry a reason.
    check(
      'orders_failure_reason_iff_failed',
      sql`(${table.state} = 'FAILED') = (${table.failureReason} IS NOT NULL)`,
    ),
  ],
);

export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    seatId: uuid('seat_id')
      .notNull()
      .references(() => seats.id, { onDelete: 'restrict' }),
    // Denormalised on purpose: what the customer actually paid must not move
    // when the seat's catalogue price changes later.
    seatCode: text('seat_code').notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('order_lines_order_seat_uq').on(table.orderId, table.seatId),
    check('order_lines_price_non_negative', sql`${table.priceMinor} >= 0`),
  ],
);

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('ledger_accounts_name_uq').on(table.name),
    check(
      'ledger_accounts_type_valid',
      sql`${table.type} IN ('ASSET','LIABILITY','REVENUE','EXPENSE','EQUITY')`,
    ),
  ],
);

/** Groups entries so the debits-equal-credits invariant has something to hold. */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // No index on `reference`: TICK-6 measured it at zero scans. It returns with
  // the query that needs it, not before.
  () => [],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    direction: text('direction').notNull(),
    // Always positive; `direction` carries the sign. A signed amount would
    // make "negative debit" representable.
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('ledger_entries_direction_valid', sql`${table.direction} IN ('DEBIT','CREDIT')`),
    check('ledger_entries_amount_positive', sql`${table.amountMinor} > 0`),
    index('ledger_entries_account_idx').on(table.accountId, table.createdAt),
    index('ledger_entries_transaction_idx').on(table.transactionId),
  ],
);

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

/** Makes retried POSTs safe: same key + same request returns the stored reply. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idempotency_keys_expiry_idx').on(table.expiresAt)],
);

/** Inbox dedupe: records a message id already handled, so replays are no-ops. */
export const processedEvents = pgTable(
  'processed_events',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
    succeeded: boolean('succeeded').notNull().default(true),
  },
  (table) => [index('processed_events_kind_idx').on(table.kind, table.processedAt)],
);
