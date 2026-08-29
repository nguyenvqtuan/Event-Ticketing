import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotencyInterceptor } from '../../shared/infrastructure/idempotency/idempotency.interceptor.js';
import { ZodValidationPipe } from '../../shared/interface/zod-validation.pipe.js';
import { CreateEventUseCase } from '../application/create-event.use-case.js';
import { GetEventOverviewUseCase } from '../application/get-event-overview.use-case.js';
import { ListSeatsUseCase } from '../application/list-seats.use-case.js';
import {
  type CreateEventDto,
  createEventSchema,
  eventIdSchema,
  type ListSeatsQueryDto,
  listSeatsQuerySchema,
} from './event.dto.js';

/**
 * Interface layer. Maps HTTP onto use cases and domain results onto response
 * bodies. There is no business logic here — no `if` about domain state, no
 * SQL, no transaction handling.
 */
@Controller('events')
export class EventsController {
  constructor(
    private readonly createEvent: CreateEventUseCase,
    private readonly getOverview: GetEventOverviewUseCase,
    private readonly listSeats: ListSeatsUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  async create(@Body(new ZodValidationPipe(createEventSchema)) dto: CreateEventDto) {
    const result = await this.createEvent.execute({
      id: randomUUID(),
      name: dto.name,
      startsAt: dto.startsAt,
      salesOpenAt: dto.salesOpenAt,
      salesCloseAt: dto.salesCloseAt,
      rows: dto.seatMap.rows,
      seatsPerRow: dto.seatMap.seatsPerRow,
      priceMinor: dto.priceMinor,
      currency: dto.currency,
    });

    return {
      id: result.eventId,
      seatsCreated: result.seatsCreated,
      totalSeats: result.totalSeats,
    };
  }

  @Get(':id')
  async findOne(@Param('id', new ZodValidationPipe(eventIdSchema)) id: string) {
    const overview = await this.getOverview.execute(id, new Date());

    return {
      id: overview.id,
      name: overview.name,
      startsAt: overview.startsAt,
      salesOpenAt: overview.salesOpenAt,
      salesCloseAt: overview.salesCloseAt,
      onSale: overview.onSale,
      seats: overview.seats,
    };
  }

  @Get(':id/seats')
  async seats(
    @Param('id', new ZodValidationPipe(eventIdSchema)) id: string,
    @Query(new ZodValidationPipe(listSeatsQuerySchema)) query: ListSeatsQueryDto,
  ) {
    const page = await this.listSeats.execute({
      eventId: id,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      seats: page.seats,
      pagination: {
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      },
    };
  }
}
