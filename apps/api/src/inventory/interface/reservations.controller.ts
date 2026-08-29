import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { IdempotencyInterceptor } from '../../shared/infrastructure/idempotency/idempotency.interceptor.js';
import { ZodValidationPipe } from '../../shared/interface/zod-validation.pipe.js';
import { CancelReservationUseCase } from '../application/cancel-reservation.use-case.js';
import { HoldSeatsUseCase } from '../application/hold-seats.use-case.js';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation-repository.port.js';
import {
  type CreateReservationDto,
  createReservationSchema,
  reservationIdSchema,
} from './reservation.dto.js';

@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly holdSeats: HoldSeatsUseCase,
    private readonly cancelReservation: CancelReservationUseCase,
    // Injected by token: the interface has no runtime representation.
    @Inject(RESERVATION_REPOSITORY)
    private readonly reservations: ReservationRepository,
    private readonly config: AppConfigService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  async create(@Body(new ZodValidationPipe(createReservationSchema)) dto: CreateReservationDto) {
    const reservation = await this.holdSeats.execute({
      id: randomUUID(),
      eventId: dto.eventId,
      holderId: dto.holderId,
      seatIds: dto.seatIds,
      now: new Date(),
      // Configurable per deployment via RESERVATION_TTL_SECONDS (TICK-2).
      ttlSeconds: this.config.reservationTtlSeconds,
    });

    return {
      id: reservation.id,
      eventId: reservation.eventId,
      holderId: reservation.holderId,
      seatIds: reservation.seatIds,
      state: reservation.state,
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
    };
  }

  /**
   * Releases a hold. Optimistic: no lock is held across the read-modify-write,
   * and a concurrent change is rejected with 409 rather than overwritten.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id', new ZodValidationPipe(reservationIdSchema)) id: string) {
    const reservation = await this.cancelReservation.execute(id);

    return {
      id: reservation.id,
      state: reservation.state,
      seatIds: reservation.seatIds,
      version: reservation.version + 1,
    };
  }

  @Get(':id')
  async findOne(@Param('id', new ZodValidationPipe(reservationIdSchema)) id: string) {
    const reservation = await this.reservations.findById(id);

    if (!reservation) {
      throw new NotFoundException(`Reservation ${id} not found`);
    }

    const now = new Date();

    return {
      id: reservation.id,
      eventId: reservation.eventId,
      holderId: reservation.holderId,
      seatIds: reservation.seatIds,
      state: reservation.state,
      expiresAt: reservation.expiresAt,
      version: reservation.version,
      // Expiry is a fact about the clock, not a stored flag: a hold past its
      // TTL reports expired even while its row still says PENDING.
      expired: reservation.isExpired(now),
      holdsSeats: reservation.holdsSeats && !reservation.isExpired(now),
    };
  }
}
