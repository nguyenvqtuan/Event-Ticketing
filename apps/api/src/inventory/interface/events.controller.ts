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
import {
  type CreateEventResponse,
  type EventListResponse,
  type EventResponse,
  type SeatPageResponse,
} from '@repo/contracts';
import { IdempotencyInterceptor } from '../../shared/infrastructure/idempotency/idempotency.interceptor.js';
import { ZodValidationPipe } from '../../shared/interface/zod-validation.pipe.js';
import { CreateEventUseCase } from '../application/create-event.use-case.js';
import { GetEventOverviewUseCase } from '../application/get-event-overview.use-case.js';
import { ListEventsUseCase } from '../application/list-events.use-case.js';
import { ListSeatsUseCase } from '../application/list-seats.use-case.js';
import {
  type CreateEventDto,
  createEventSchema,
  eventIdSchema,
  type ListEventsQueryDto,
  listEventsQuerySchema,
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
    private readonly listEvents: ListEventsUseCase,
    private readonly listSeats: ListSeatsUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @Body(new ZodValidationPipe(createEventSchema)) dto: CreateEventDto,
  ): Promise<CreateEventResponse> {
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

  /**
   * Declared BEFORE `:id`, because Nest matches routes in declaration order and
   * a bare `/events` would otherwise never reach here.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listEventsQuerySchema)) query: ListEventsQueryDto,
  ): Promise<EventListResponse> {
    const page = await this.listEvents.execute({
      limit: query.limit,
      offset: query.offset,
      now: new Date(),
    });

    return {
      events: page.events.map((event) => ({
        id: event.id,
        name: event.name,
        startsAt: event.startsAt.toISOString(),
        salesOpenAt: event.salesOpenAt.toISOString(),
        salesCloseAt: event.salesCloseAt.toISOString(),
        onSale: event.onSale,
      })),
      pagination: { total: page.total, limit: page.limit, offset: page.offset },
    };
  }

  @Get(':id')
  async findOne(
    @Param('id', new ZodValidationPipe(eventIdSchema)) id: string,
  ): Promise<EventResponse> {
    const overview = await this.getOverview.execute(id, new Date());

    return {
      id: overview.id,
      name: overview.name,
      // Serialised explicitly rather than left to JSON.stringify. The wire
      // format is a string either way; saying so is what lets the response be
      // typed against the shared contract instead of against `Date`.
      startsAt: overview.startsAt.toISOString(),
      salesOpenAt: overview.salesOpenAt.toISOString(),
      salesCloseAt: overview.salesCloseAt.toISOString(),
      onSale: overview.onSale,
      seats: overview.seats,
    };
  }

  @Get(':id/seats')
  async seats(
    @Param('id', new ZodValidationPipe(eventIdSchema)) id: string,
    @Query(new ZodValidationPipe(listSeatsQuerySchema)) query: ListSeatsQueryDto,
  ): Promise<SeatPageResponse> {
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
