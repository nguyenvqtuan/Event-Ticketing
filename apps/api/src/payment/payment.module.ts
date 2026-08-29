import { Module } from '@nestjs/common';

/**
 * Bounded context: **Payment / Ledger**.
 *
 * Owns Order and the double-entry ledger. It receives a translated view of a
 * confirmed reservation — ids and priced lines — never Inventory's Reservation
 * aggregate itself. That translation is what keeps a change to the hold flow
 * from breaking billing.
 *
 * Empty for now by design; see InventoryModule.
 */
@Module({})
export class PaymentModule {}
