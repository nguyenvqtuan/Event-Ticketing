import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { ConcurrentModification, InvariantViolation } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { DatabaseContext } from '../../shared/infrastructure/database/database.module.js';
import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  orderLines,
  orders,
} from '../../shared/infrastructure/database/schema.js';
import { type LedgerTransaction } from '../domain/ledger.js';
import { Order } from '../domain/order.js';
import { type LedgerRepository, type OrderRepository } from '../domain/payment-repository.port.js';

@Injectable()
export class DrizzleOrderRepository implements OrderRepository {
  constructor(private readonly context: DatabaseContext) {}

  async save(order: Order): Promise<void> {
    const db = this.context.db;

    await db.insert(orders).values({
      id: order.id,
      reservationId: order.reservationId,
      state: order.state,
      totalMinor: order.total.amountMinor,
      currency: order.total.currency,
      failureReason: order.reasonForFailure ?? null,
      placedAt: order.placedAt,
    });

    // Prices are denormalised onto the lines on purpose: what the customer
    // paid must not move when the seat catalogue changes.
    await db.insert(orderLines).values(
      order.lines.map((line) => ({
        orderId: order.id,
        seatId: line.seatId,
        seatCode: line.seatCode,
        priceMinor: line.price.amountMinor,
        currency: line.price.currency,
      })),
    );
  }

  async findByReservationId(reservationId: string): Promise<Order | null> {
    const [row] = await this.context.db
      .select()
      .from(orders)
      .where(eq(orders.reservationId, reservationId))
      .limit(1);

    return row ? this.hydrate(row) : null;
  }

  async findByIdForUpdate(id: string): Promise<Order | null> {
    // Locks the row so a concurrent refund of the same order queues behind us
    // rather than both reading PAID.
    const locked = await this.context.db.execute<{ id: string }>(sql`
      SELECT id FROM orders WHERE id = ${id} FOR UPDATE
    `);

    if (locked.rows.length === 0) return null;

    const [row] = await this.context.db.select().from(orders).where(eq(orders.id, id)).limit(1);

    return row ? this.hydrate(row) : null;
  }

  /**
   * Optimistic update: WHERE id = ? AND version = ?, bumping in the same
   * statement. Zero rows affected means the row moved since we read it.
   */
  async updateState(order: Order): Promise<void> {
    const updated = await this.context.db
      .update(orders)
      .set({
        state: order.state,
        failureReason: order.reasonForFailure ?? null,
        version: order.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
      .returning({ id: orders.id });

    if (updated.length === 0) {
      throw new ConcurrentModification('Order', order.id);
    }
  }

  private async hydrate(row: typeof orders.$inferSelect): Promise<Order> {
    const lines = await this.context.db
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, row.id));

    // rehydrate, not place()-then-walk-forward: replaying transitions that
    // already happened is fragile and rejects states the rules no longer
    // allow reaching.
    return Order.rehydrate({
      id: row.id,
      reservationId: row.reservationId,
      lines: lines.map((line) => ({
        seatId: line.seatId,
        seatCode: line.seatCode,
        price: Money.of(line.priceMinor, line.currency),
      })),
      total: Money.of(Number(row.totalMinor), row.currency),
      placedAt: row.placedAt,
      state: row.state as Order['state'],
      failureReason: row.failureReason ?? undefined,
      version: row.version,
    });
  }
}

@Injectable()
export class DrizzleLedgerRepository implements LedgerRepository {
  constructor(private readonly context: DatabaseContext) {}

  async post(transaction: LedgerTransaction): Promise<void> {
    const db = this.context.db;
    const currency = transaction.amount.currency;

    await db.insert(ledgerTransactions).values({
      id: transaction.id,
      reference: transaction.reference,
      currency,
      occurredAt: transaction.occurredAt,
    });

    // One statement, so the deferred balance trigger sees the whole
    // transaction at COMMIT rather than a half-written one.
    await db.insert(ledgerEntries).values(
      transaction.entries.map((entry) => ({
        transactionId: transaction.id,
        accountId: entry.accountId,
        direction: entry.direction,
        amountMinor: entry.amount.amountMinor,
        currency: entry.amount.currency,
      })),
    );
  }

  async accountId(name: string, currency: string): Promise<string> {
    const [account] = await this.context.db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.name, name), eq(ledgerAccounts.currency, currency)))
      .limit(1);

    if (!account) {
      // Accounts are reference data seeded by migration. Creating one on
      // demand would let a typo open a real account, and a chart of accounts
      // that invents entries cannot be reconciled.
      throw new InvariantViolation(
        `No ledger account "${name}" for currency ${currency}. Add it to the chart of accounts.`,
      );
    }

    return account.id;
  }
}
