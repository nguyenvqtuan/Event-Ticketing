import { Module } from '@nestjs/common';

/**
 * Bounded context: **Ticketing / Inventory**.
 *
 * Owns Event, Seat and Reservation — what exists to sell and who is currently
 * holding it. Knows nothing about money changing hands.
 *
 * Empty for now by design: TICK-4 delivers the domain model, and the domain
 * is plain classes rather than providers. Use cases, repository ports and
 * controllers arrive in TICK-5 onward and register here.
 */
@Module({})
export class InventoryModule {}
