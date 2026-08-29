import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * TICK-15: liveness and readiness, including the failure the DoD asks for —
 * readiness must answer 503 when the database is down.
 *
 * These run the compiled entrypoint in a child process rather than through
 * `Test.createTestingModule`, because a health check is only worth what it
 * reports about the real process: dependencies are failed by pointing the API
 * at a database that is not there, and at one that has never been migrated,
 * rather than by substituting a fake probe. What an orchestrator would see is
 * exactly what these assert.
 *
 * Requires `pnpm build` (turbo runs it first via the task graph); the database
 * comes from test/support/global-setup.ts, already migrated.
 */
const MAIN = resolve(process.cwd(), 'dist/main.js');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/event_ticketing';

/** Nothing listens here, so connecting fails at once instead of hanging. */
const UNREACHABLE_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:59999/event_ticketing';

/**
 * The same server's default database: reachable, but this project has never
 * migrated it — so the schema half of the check fails on its own, with
 * connectivity healthy.
 */
const UNMIGRATED_DATABASE_URL = (() => {
  const url = new URL(DATABASE_URL);
  url.pathname = '/postgres';
  return url.toString();
})();

interface RunningApi {
  port: number;
  stop: () => Promise<void>;
}

/** Boots the API and resolves once it is answering, or throws trying. */
async function startApi(databaseUrl: string, port: number): Promise<RunningApi> {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      // Quiet: a failing probe logs a warning per request by design.
      LOG_LEVEL: 'error',
      DATABASE_URL: databaseUrl,
      PORT: String(port),
    },
    stdio: 'ignore',
  });

  const stop = async (): Promise<void> => {
    child.kill('SIGKILL');
    await new Promise((resolvePromise) => child.on('close', resolvePromise));
  };

  // Liveness is the right probe to wait on: it answers as soon as the process
  // is listening, whatever state its dependencies are in.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
      return { port, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await stop();
  throw new Error(`API did not start on port ${port}`);
}

/** Terminus's response shape: one entry per indicator, split by outcome. */
interface HealthBody {
  status: 'ok' | 'error' | 'shutting_down';
  info: Record<string, { status: string; pending?: string[] }>;
  error: Record<string, { status: string; pending?: string[] }>;
}

const get = async (port: number, path: string): Promise<{ status: number; body: HealthBody }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);

  return { status: response.status, body: (await response.json()) as HealthBody };
};

describe('Health endpoints (e2e)', () => {
  describe('with the database unreachable', () => {
    let api: RunningApi;

    beforeAll(async () => {
      api = await startApi(UNREACHABLE_DATABASE_URL, 4201);
    });

    afterAll(async () => {
      await api.stop();
    });

    it('GET /healthz stays 200 — a dead dependency is no reason to restart', async () => {
      const { status, body } = await get(api.port, '/healthz');

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: 'ok',
        info: { process: { status: 'up', state: expect.stringMatching(/^(ok|degraded)$/) } },
        error: {},
      });
    });

    it('GET /readyz answers 503 and names the dependency that is down', async () => {
      const { status, body } = await get(api.port, '/readyz');

      expect(status).toBe(503);
      expect(body).toMatchObject({
        status: 'error',
        // Unverifiable is not the same as applied: the ledger is a table in
        // the database that just failed to answer.
        error: { database: { status: 'down' }, migrations: { status: 'down' } },
      });
    });
  });

  describe('against the live database', () => {
    let api: RunningApi;

    beforeAll(async () => {
      api = await startApi(DATABASE_URL, 4202);
    });

    afterAll(async () => {
      await api.stop();
    });

    it('GET /readyz answers 200 when the schema is current', async () => {
      const { status, body } = await get(api.port, '/readyz');

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' }, migrations: { status: 'up' } },
        error: {},
      });
    });
  });

  describe('against a database that has never been migrated', () => {
    let api: RunningApi;

    beforeAll(async () => {
      api = await startApi(UNMIGRATED_DATABASE_URL, 4203);
    });

    afterAll(async () => {
      await api.stop();
    });

    it('GET /readyz answers 503 and names the migrations still to run', async () => {
      const { status, body } = await get(api.port, '/readyz');

      expect(status).toBe(503);
      expect(body).toMatchObject({
        // Reachable — this instance is simply running ahead of its schema.
        info: { database: { status: 'up' } },
        error: { migrations: { status: 'down' } },
      });
      // Named, so an operator reads which migration to run rather than guessing.
      expect(body.error.migrations?.pending).toContain('0000_init_schema');
    });
  });
});
