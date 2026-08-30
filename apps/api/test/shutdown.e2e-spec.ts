import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { resetDatabase } from './support/database.js';

/**
 * TICK-19's DoD: SIGTERM mid-request, and that request still completes.
 *
 * This has to run out of process. Graceful shutdown IS the process reacting to
 * a signal — its exit code, its refusal of new connections, the order it tears
 * things down in — and none of that is observable from a `Test.createTestingModule`
 * app that never receives a signal. So these spawn the real compiled entrypoint
 * and drive it the way an orchestrator would.
 *
 * Requires `pnpm build` (turbo runs it first; test:e2e dependsOn build).
 */
const MAIN = resolve(process.cwd(), 'dist/main.js');

/** Per-worker, because suites run in parallel processes and ports are global. */
const PORT = 4300 + Number(process.env.JEST_WORKER_ID ?? 1);

const DATABASE_URL = process.env.DATABASE_URL!;

interface Response {
  status: number;
  body: string;
}

/**
 * A request on its own connection.
 *
 * `agent: false` rather than `fetch`, deliberately: undici keeps sockets alive
 * in a global pool, and a leftover idle socket is exactly the thing that makes
 * a drain look like it hung. One socket per request, closed when it is done,
 * means the only connection still open at SIGTERM is the one this test is
 * deliberately holding open.
 */
function send(method: string, path: string, payload?: unknown): Promise<Response> {
  return new Promise((resolvePromise, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);

    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path,
        agent: false,
        headers: body
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: text }));
      },
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

interface RunningApi {
  child: ChildProcess;
  /** Resolves with how the process finally went away. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  output: () => string;
}

async function startApi(env: NodeJS.ProcessEnv = {}): Promise<RunningApi> {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL,
      PORT: String(PORT),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  });

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await send('GET', '/healthz');
      return { child, exited, output: () => output };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  child.kill('SIGKILL');
  throw new Error(`API did not start on port ${PORT}:\n${output}`);
}

/** An event that is on sale now, plus the id of one of its seats. */
async function seedSeat(): Promise<{ eventId: string; seatId: string }> {
  const created = await send('POST', '/events', {
    name: `Shutdown ${Date.now()}`,
    salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
    salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    seatMap: { rows: 1, seatsPerRow: 2 },
    priceMinor: 5000,
    currency: 'GBP',
  });
  expect(created.status).toBe(201);

  const eventId = (JSON.parse(created.body) as { id: string }).id;
  const seats = await send('GET', `/events/${eventId}/seats?limit=1`);
  const seatId = (JSON.parse(seats.body) as { seats: { id: string }[] }).seats[0]!.id;

  return { eventId, seatId };
}

/** The hold that the tests deliberately leave stuck on the seat lock. */
const holdRequest = (eventId: string, seatId: string) =>
  send('POST', '/reservations', {
    eventId,
    holderId: randomUUID(),
    seatIds: [seatId],
  }).catch((error: Error) => error);

/**
 * Holds a `FOR UPDATE` lock on one seat row, so a hold request for that seat
 * blocks inside its transaction until `release()` is called.
 *
 * This is what makes "mid-request" deterministic. A sleep would be a guess
 * about timing; this pins the request open in the middle of real work — a
 * transaction with a database connection checked out — until the test says
 * otherwise, which is precisely the state a drain has to survive.
 */
async function lockSeat(seatId: string): Promise<{ release: () => Promise<void> }> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM seats WHERE id = $1 FOR UPDATE', [seatId]);

  return {
    release: async () => {
      await client.query('ROLLBACK');
      await client.end();
    },
  };
}

/** Waits until someone is actually blocked on a lock, rather than sleeping. */
async function waitForLockWaiter(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active'`,
      );
      if (Number(rows[0]?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('No request ever blocked on the seat lock');
  } finally {
    await client.end();
  }
}

describe('Graceful shutdown (e2e)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('finishes an in-flight request, refuses new ones, and exits 0', async () => {
    const api = await startApi();
    const { eventId, seatId } = await seedSeat();
    const lock = await lockSeat(seatId);

    // In flight and stuck on the lock — deliberately NOT awaited yet.
    const inFlight = holdRequest(eventId, seatId);

    await waitForLockWaiter();

    api.child.kill('SIGTERM');

    // Stops accepting NEW connections: the drain is not a grace period during
    // which the instance keeps taking work it will not finish.
    await new Promise((r) => setTimeout(r, 300));
    await expect(send('GET', '/healthz')).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    // The request that was already running is allowed to finish its work.
    await lock.release();

    const result = await inFlight;
    expect(result).not.toBeInstanceOf(Error);
    const response = result as Response;
    // Any real HTTP answer proves the point: the socket was not cut, the
    // transaction was not rolled out from under it, and the pool was still
    // open when the query resumed.
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);

    const { code, signal } = await api.exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);

    // AC: the pool is closed and the logs make it out before the process goes.
    expect(api.output()).toMatch(/SIGTERM received/);
    expect(api.output()).toMatch(/Drained cleanly; connection pool closed/);
  }, 30_000);

  it('gives up on a request that never finishes, once the timeout expires', async () => {
    const api = await startApi({ SHUTDOWN_TIMEOUT_MS: '1000' });
    const { eventId, seatId } = await seedSeat();
    const lock = await lockSeat(seatId);

    const inFlight = holdRequest(eventId, seatId);

    await waitForLockWaiter();

    const askedAt = Date.now();
    api.child.kill('SIGTERM');

    const { code } = await api.exited;
    const took = Date.now() - askedAt;

    // Bounded: the whole point of the deadline is that a stuck request cannot
    // hold the container open until the platform SIGKILLs it.
    expect(took).toBeLessThan(10_000);
    // Non-zero, because work WAS abandoned — a clean drain exits 0, and the
    // two outcomes must not look the same to whatever reads exit codes.
    expect(code).toBe(1);
    expect(api.output()).toMatch(/did not finish within 1000ms/);

    await lock.release();
    await inFlight;
  }, 30_000);
});
