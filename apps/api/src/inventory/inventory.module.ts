import { Module } from '@nestjs/common';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../shared/domain/transaction-runner.port.js';
import { IdempotencyInterceptor } from '../shared/infrastructure/idempotency/idempotency.interceptor.js';
import { CreateEventUseCase } from './application/create-event.use-case.js';
import { GetEventOverviewUseCase } from './application/get-event-overview.use-case.js';
import { ListEventsUseCase } from './application/list-events.use-case.js';
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
import { CancelReservationUseCase } from './application/cancel-reservation.use-case.js';
import { ConfirmReservationUseCase } from './application/confirm-reservation.use-case.js';
import { ExpireReservationsUseCase } from './application/expire-reservations.use-case.js';
import { HoldSeatsUseCase } from './application/hold-seats.use-case.js';
import { DrizzleEventRepository } from './infrastructure/drizzle-event.repository.js';
import { DrizzleReservationRepository } from './infrastructure/drizzle-reservation.repository.js';
import { DrizzleSeatRepository } from './infrastructure/drizzle-seat.repository.js';
import { ReservationSweeper } from './infrastructure/reservation-sweeper.job.js';
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
    ReservationSweeper,
    {
      provide: ConfirmReservationUseCase,
      useFactory: (reservations: ReservationRepository, transaction: TransactionRunner) =>
        new ConfirmReservationUseCase(reservations, transaction),
      inject: [RESERVATION_REPOSITORY, TRANSACTION_RUNNER],
    },
    {
      provide: ExpireReservationsUseCase,
      useFactory: (reservations: ReservationRepository, transaction: TransactionRunner) =>
        new ExpireReservationsUseCase(reservations, transaction),
      inject: [RESERVATION_REPOSITORY, TRANSACTION_RUNNER],
    },
    {
      provide: CancelReservationUseCase,
      useFactory: (reservations: ReservationRepository, transaction: TransactionRunner) =>
        new CancelReservationUseCase(reservations, transaction),
      inject: [RESERVATION_REPOSITORY, TRANSACTION_RUNNER],
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
    {
      provide: ListEventsUseCase,
      useFactory: (events: EventRepository) => new ListEventsUseCase(events),
      inject: [EVENT_REPOSITORY],
    },
  ],
  // Exported so the Payment context's adapter can claim seats through the
  // repository rather than reaching into the database itself. The dependency
  // points Payment -> Inventory, never back.
  exports: [RESERVATION_REPOSITORY, SEAT_REPOSITORY, EVENT_REPOSITORY],
})
export class InventoryModule {}
