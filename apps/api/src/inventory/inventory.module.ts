import { Module } from '@nestjs/common';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../shared/domain/transaction-runner.port.js';
import { IdempotencyInterceptor } from '../shared/infrastructure/idempotency/idempotency.interceptor.js';
import { CreateEventUseCase } from './application/create-event.use-case.js';
import { GetEventOverviewUseCase } from './application/get-event-overview.use-case.js';
import { ListSeatsUseCase } from './application/list-seats.use-case.js';
import {
  EVENT_REPOSITORY,
  SEAT_REPOSITORY,
  type EventRepository,
  type SeatRepository,
} from './domain/inventory-repository.port.js';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from './domain/reservation-repository.port.js';
import { HoldSeatsUseCase } from './application/hold-seats.use-case.js';
import { DrizzleEventRepository } from './infrastructure/drizzle-event.repository.js';
import { DrizzleReservationRepository } from './infrastructure/drizzle-reservation.repository.js';
import { DrizzleSeatRepository } from './infrastructure/drizzle-seat.repository.js';
import { EventsController } from './interface/events.controller.js';
import { ReservationsController } from './interface/reservations.controller.js';

/**
 * Bounded context: **Ticketing / Inventory** — see docs/domain.md.
 *
 * Composition root for the slice. Ports are bound to adapters here, and the
 * undecorated use cases are constructed with `useFactory`, so `domain/` and
 * `application/` stay free of framework imports.
 */
@Module({
  controllers: [EventsController, ReservationsController],
  providers: [
    IdempotencyInterceptor,

    { provide: EVENT_REPOSITORY, useClass: DrizzleEventRepository },
    { provide: SEAT_REPOSITORY, useClass: DrizzleSeatRepository },
    { provide: RESERVATION_REPOSITORY, useClass: DrizzleReservationRepository },

    {
      provide: HoldSeatsUseCase,
      useFactory: (
        events: EventRepository,
        seats: SeatRepository,
        reservations: ReservationRepository,
        transaction: TransactionRunner,
      ) => new HoldSeatsUseCase(events, seats, reservations, transaction),
      inject: [EVENT_REPOSITORY, SEAT_REPOSITORY, RESERVATION_REPOSITORY, TRANSACTION_RUNNER],
    },

    {
      provide: CreateEventUseCase,
      useFactory: (
        events: EventRepository,
        seats: SeatRepository,
        transaction: TransactionRunner,
      ) => new CreateEventUseCase(events, seats, transaction),
      inject: [EVENT_REPOSITORY, SEAT_REPOSITORY, TRANSACTION_RUNNER],
    },
    {
      provide: GetEventOverviewUseCase,
      useFactory: (events: EventRepository, seats: SeatRepository) =>
        new GetEventOverviewUseCase(events, seats),
      inject: [EVENT_REPOSITORY, SEAT_REPOSITORY],
    },
    {
      provide: ListSeatsUseCase,
      useFactory: (events: EventRepository, seats: SeatRepository) =>
        new ListSeatsUseCase(events, seats),
      inject: [EVENT_REPOSITORY, SEAT_REPOSITORY],
    },
  ],
})
export class InventoryModule {}
