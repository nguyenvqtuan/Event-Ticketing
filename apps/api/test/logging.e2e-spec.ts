import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';
import {
  CORRELATION_HEADER,
  createPinoLogger,
  PINO_INSTANCE,
  PinoLoggerService,
} from '../src/shared/infrastructure/logging/logging.module.js';

interface LogLine {
  level: number;
  time: number;
  msg: string;
  correlationId?: string;
  path?: string;
  latencyMs?: number;
  req?: { method?: string; path?: string; idempotencyKey?: string; headers?: unknown };
  res?: { status?: number };
  [key: string]: unknown;
}

/**
 * TICK-14: structured logging and correlation IDs, against a real app.
 *
 * Logs are captured by pointing pino at an in-memory stream, so these assert
 * on what would actually be written rather than on configuration.
 */
describe('Structured logging (e2e)', () => {
  let app: INestApplication;
  let lines: LogLine[] = [];

  const capture = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const raw of chunk.toString().split('\n')) {
        if (raw.trim()) {
          try {
            lines.push(JSON.parse(raw) as LogLine);
          } catch {
            // pino writes one JSON object per line; anything else is noise.
          }
        }
      }
      callback();
    },
  });

  // A clean database per suite: worker databases are reused across the
  // suites a worker runs, and one suite's rows are another's noise.
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeAll(async () => {
    // Override the shared pino instance with one writing to an in-memory
    // stream. Everything else — the mixin, serializers, redaction and both
    // middlewares — is the app's real configuration, so these assertions are
    // about what would actually be written in production.
    // One pino instance shared by the HTTP middleware (via the overridden
    // provider) and by Nest's logger, so both streams land in `capture`.
    const captureLogger = createPinoLogger('debug', capture);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PINO_INSTANCE)
      .useValue(captureLogger)
      .compile();

    app = moduleRef.createNestApplication();
    app.useLogger(new PinoLoggerService(captureLogger));
    // Listening for the suite's lifetime because this suite races concurrent
    // requests: supertest closes a server it had to start itself as soon as the
    // FIRST request finishes, resetting the ones still in flight (docs/testing.md).
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lines = [];
  });

  /** Creates an event and returns its id — enough to produce real log traffic. */
  async function createEvent(headers: Record<string, string> = {}) {
    const req = request(app.getHttpServer()).post('/events');
    for (const [name, value] of Object.entries(headers)) req.set(name, value);

    return req
      .send({
        name: `Logging ${randomUUID()}`,
        salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
        salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        seatMap: { rows: 1, seatsPerRow: 2 },
        priceMinor: 5000,
        currency: 'GBP',
      })
      .expect(201);
  }

  describe('logs are structured JSON', () => {
    it('emits parseable JSON with the standard fields', async () => {
      await createEvent();

      const completion = lines.find((line) => line.latencyMs !== undefined);

      expect(completion).toBeDefined();
      expect(typeof completion!.time).toBe('number'); // timestamp
      expect(typeof completion!.level).toBe('number'); // level
      expect(typeof completion!.msg).toBe('string'); // msg
      expect(typeof completion!.correlationId).toBe('string');
      expect(completion!.req?.path).toBe('/events');
      expect(typeof completion!.latencyMs).toBe('number');
      expect(completion!.res?.status).toBe(201);
    });
  });

  describe('correlation id', () => {
    it('honours an inbound X-Correlation-Id', async () => {
      const provided = randomUUID();

      const response = await createEvent({ 'X-Correlation-Id': provided });

      expect(response.headers[CORRELATION_HEADER]).toBe(provided);
      expect(lines.every((line) => line.correlationId === provided)).toBe(true);
    });

    it('accepts X-Request-Id as an alternative', async () => {
      const provided = randomUUID();

      await createEvent({ 'X-Request-Id': provided });

      expect(lines.some((line) => line.correlationId === provided)).toBe(true);
    });

    it('generates one when the caller supplies none, and echoes it back', async () => {
      const response = await createEvent();

      const echoed = response.headers[CORRELATION_HEADER] as string;
      expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
      expect(lines.some((line) => line.correlationId === echoed)).toBe(true);
    });

    it('gives concurrent requests DIFFERENT ids', async () => {
      // The real test of AsyncLocalStorage: interleaved requests must not
      // share or overwrite each other's context.
      await Promise.all([createEvent(), createEvent(), createEvent()]);

      const ids = new Set(
        lines.filter((line) => line.latencyMs !== undefined).map((line) => line.correlationId),
      );

      expect(ids.size).toBe(3);
    });
  });

  describe('DoD — the id reaches logs emitted DEEP in a service call', () => {
    it('tags a log from an infrastructure adapter three layers below the controller', async () => {
      const correlationId = randomUUID();

      // Build a paid-for reservation so the checkout path runs:
      //   controller -> CheckoutUseCase -> SeatClaimPort -> InventorySeatClaimAdapter
      const event = await createEvent();
      const seats = await request(app.getHttpServer())
        .get(`/events/${event.body.id}/seats?limit=2`)
        .expect(200);
      const seatIds = (seats.body.seats as { id: string }[]).map((s) => s.id);

      const held = await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId: event.body.id, holderId: randomUUID(), seatIds })
        .expect(201);

      lines = [];

      await request(app.getHttpServer())
        .post(`/reservations/${held.body.id}/pay`)
        .set('X-Correlation-Id', correlationId)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: 10_000, currency: 'GBP' })
        .expect(200);

      // The adapter logs this. Nothing passed it a correlation id — it reads
      // one from AsyncLocalStorage set by middleware at the edge.
      const deep = lines.find((line) => line.msg.includes('Claimed'));

      expect(deep).toBeDefined();
      expect(deep!.correlationId).toBe(correlationId);
      expect(deep!.msg).toMatch(/Claimed 2 seat\(s\)/);
    });
  });

  describe('sensitive data', () => {
    it('never logs the request body', async () => {
      await createEvent({ 'X-Correlation-Id': randomUUID() });

      // Bodies are not serialised at all — the safe default rather than a
      // redaction list someone has to remember to extend.
      expect(lines.every((line) => line.req === undefined || !('body' in line.req))).toBe(true);
    });

    it('strips the Authorization header', async () => {
      await createEvent({ Authorization: 'Bearer super-secret-token' });

      const serialised = JSON.stringify(lines);
      expect(serialised).not.toContain('super-secret-token');
      expect(serialised).not.toContain('Bearer');
    });

    it('DOES log the idempotency key, which the AC permits and tracing needs', async () => {
      const key = randomUUID();
      const event = await createEvent();
      const seats = await request(app.getHttpServer())
        .get(`/events/${event.body.id}/seats?limit=1`)
        .expect(200);

      const held = await request(app.getHttpServer())
        .post('/reservations')
        .send({
          eventId: event.body.id,
          holderId: randomUUID(),
          seatIds: [seats.body.seats[0].id],
        })
        .expect(201);

      lines = [];

      await request(app.getHttpServer())
        .post(`/reservations/${held.body.id}/pay`)
        .set('Idempotency-Key', key)
        .send({ amountMinor: 5000, currency: 'GBP' })
        .expect(200);

      expect(lines.some((line) => line.req?.idempotencyKey === key)).toBe(true);
    });
  });
});
