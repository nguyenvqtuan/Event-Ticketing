import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';
import { Money } from '../src/shared/domain/money.js';
import { Event } from '../src/inventory/domain/event.js';
import {
  EVENT_REPOSITORY,
  SEAT_REPOSITORY,
  type EventRepository,
  type SeatRepository,
} from '../src/inventory/domain/inventory-repository.port.js';
import { generateSeatMap } from '../src/inventory/domain/seat-map.js';

/**
 * AC 5: "Generating seats twice for the same event produces no duplicates."
 *
 * The HTTP tests cannot show this — every POST /events mints a new event id, so
 * a seat collision never arises. This drives the repository directly against
 * the SAME event id, which is the case the unique index actually guards.
 */
describe('Seat generation idempotency (integration)', () => {
  let moduleRef: TestingModule;
  let seats: SeatRepository;
  let events: EventRepository;

  const blueprints = generateSeatMap({
    rows: 4,
    seatsPerRow: 25,
    price: Money.of(5_000, 'GBP'),
  });

  // A clean database per suite: worker databases are reused across the
  // suites a worker runs, and one suite's rows are another's noise.
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();

    seats = moduleRef.get<SeatRepository>(SEAT_REPOSITORY);
    events = moduleRef.get<EventRepository>(EVENT_REPOSITORY);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const newEvent = async () => {
    const id = randomUUID();
    await events.save(
      Event.schedule({
        id,
        name: `Idempotency ${id}`,
        startsAt: new Date('2027-06-01T19:00:00.000Z'),
        salesOpenAt: new Date('2027-01-01T00:00:00.000Z'),
        salesCloseAt: new Date('2027-06-01T00:00:00.000Z'),
      }),
    );
    return id;
  };

  it('creates every seat on the first generation', async () => {
    const eventId = await newEvent();

    expect(await seats.createMany(eventId, blueprints)).toBe(100);
    expect((await seats.overviewFor(eventId)).total).toBe(100);
  });

  it('creates NOTHING on a second identical generation', async () => {
    const eventId = await newEvent();

    await seats.createMany(eventId, blueprints);
    const secondRun = await seats.createMany(eventId, blueprints);

    expect(secondRun).toBe(0);
    expect((await seats.overviewFor(eventId)).total).toBe(100);
  });

  it('adds only the new seats when the map grows', async () => {
    const eventId = await newEvent();
    await seats.createMany(eventId, blueprints);

    // Same 4 rows plus a fifth: only the 25 new codes should be inserted.
    const larger = generateSeatMap({
      rows: 5,
      seatsPerRow: 25,
      price: Money.of(5_000, 'GBP'),
    });

    expect(await seats.createMany(eventId, larger)).toBe(25);
    expect((await seats.overviewFor(eventId)).total).toBe(125);
  });

  it('survives concurrent generation — the index decides, not a prior read', async () => {
    const eventId = await newEvent();

    const [a, b, c] = await Promise.all([
      seats.createMany(eventId, blueprints),
      seats.createMany(eventId, blueprints),
      seats.createMany(eventId, blueprints),
    ]);

    // Exactly 100 seats exist however the three racing writers split the work.
    expect(a + b + c).toBe(100);
    expect((await seats.overviewFor(eventId)).total).toBe(100);
  });

  it('keeps the seat set identical across generations', async () => {
    const eventId = await newEvent();

    await seats.createMany(eventId, blueprints);
    const first = await seats.listByAvailability({
      eventId,
      status: 'AVAILABLE',
      limit: 500,
      offset: 0,
    });

    await seats.createMany(eventId, blueprints);
    const second = await seats.listByAvailability({
      eventId,
      status: 'AVAILABLE',
      limit: 500,
      offset: 0,
    });

    expect(second.seats.map((s) => s.id)).toEqual(first.seats.map((s) => s.id));
  });
});
