import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../shared/domain/transaction-runner.port.js';
import { IdempotencyInterceptor } from '../shared/infrastructure/idempotency/idempotency.interceptor.js';
import { CheckoutUseCase } from './application/checkout.use-case.js';
import { RefundOrderUseCase } from './application/refund-order.use-case.js';
import {
  LEDGER_REPOSITORY,
  ORDER_REPOSITORY,
  SEAT_CLAIM_PORT,
  type LedgerRepository,
  type OrderRepository,
  type SeatClaimPort,
} from './domain/payment-repository.port.js';
import {
  DrizzleLedgerRepository,
  DrizzleOrderRepository,
} from './infrastructure/drizzle-payment.repository.js';
import { InventorySeatClaimAdapter } from './infrastructure/inventory-seat-claim.adapter.js';
import { OrdersController } from './interface/orders.controller.js';
import { PaymentsController } from './interface/payments.controller.js';

/**
 * Bounded context: **Payment / Ledger** — see docs/domain.md.
 *
 * Imports InventoryModule, never the reverse. Payment knows it needs seats
 * claimed; Inventory knows nothing about money. That one-way dependency is
 * what the `SeatClaimPort` adapter exists to preserve — and it is also why
 * this module owns the `/reservations/:id/pay` route rather than Inventory's
 * controller reaching into Payment.
 */
@Module({
  imports: [InventoryModule],
  controllers: [PaymentsController, OrdersController],
  providers: [
    IdempotencyInterceptor,

    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    { provide: LEDGER_REPOSITORY, useClass: DrizzleLedgerRepository },
    { provide: SEAT_CLAIM_PORT, useClass: InventorySeatClaimAdapter },

    {
      provide: CheckoutUseCase,
      useFactory: (
        seats: SeatClaimPort,
        orders: OrderRepository,
        ledger: LedgerRepository,
        transaction: TransactionRunner,
      ) => new CheckoutUseCase(seats, orders, ledger, transaction),
      inject: [SEAT_CLAIM_PORT, ORDER_REPOSITORY, LEDGER_REPOSITORY, TRANSACTION_RUNNER],
    },
    {
      provide: RefundOrderUseCase,
      useFactory: (
        orders: OrderRepository,
        ledger: LedgerRepository,
        seats: SeatClaimPort,
        transaction: TransactionRunner,
      ) => new RefundOrderUseCase(orders, ledger, seats, transaction),
      inject: [ORDER_REPOSITORY, LEDGER_REPOSITORY, SEAT_CLAIM_PORT, TRANSACTION_RUNNER],
    },
  ],
})
export class PaymentModule {}
