import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

/**
 * Provisions the database the integration suites run against, once per run.
 *
 * Testcontainers starts a real Postgres — the same image compose runs — and
 * this applies the project's own migration runner to it. A mock would hide
 * precisely what these suites exist to check: constraints, row locks,
 * transaction visibility and trigger behaviour are Postgres features, not
 * application code.
 *
 * Set `TEST_DATABASE_URL` to point at a server you already have (a compose
 * database, or a CI service container) and no container is started. The rest
 * of the flow is identical, so the two paths cannot drift.
 *
 * Jest loads this file with Node directly rather than through ts-jest, so it
 * imports nothing from the rest of the harness — `./x.js` would not resolve to
 * `./x.ts` here. What it creates is published through the environment instead,
 * which is also why `test/setup-env.ts` needs no naming convention of its own.
 */

const MIGRATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'migrate.ts');

/**
 * Migrated once; every worker database is cloned from it, so the migration
 * runner executes a single time per run rather than once per worker.
 */
const TEMPLATE_DATABASE = 'ticketing_template';

declare global {
  var __POSTGRES_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/** The path Testcontainers assumes when nothing tells it otherwise. */
const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * Points Testcontainers at the daemon when it cannot find one itself.
 *
 * Its discovery is DOCKER_HOST, then that socket path — neither of which
 * exists under a VM-based runtime such as Colima or Rancher Desktop, where the
 * endpoint lives in the docker CLI's *context*. So ask the CLI, which is the
 * one thing every such setup configures. A no-op on a stock Linux daemon and
 * in CI, where the default socket is there.
 */
function configureDockerEndpoint(): void {
  if (process.env.DOCKER_HOST || existsSync(DEFAULT_DOCKER_SOCKET)) return;

  const context = spawnSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8' },
  );

  const endpoint = context.status === 0 ? context.stdout.trim() : '';

  // Nothing found: leave it alone and let Testcontainers report the failure,
  // which says more about the machine than a guess of ours would.
  if (!endpoint) return;

  process.env.DOCKER_HOST = endpoint;

  // Ryuk, the reaper that cleans up if this process dies, mounts the daemon
  // socket. Under a VM runtime the host-side path is not one the daemon can
  // see; inside the VM it is always the default path.
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= DEFAULT_DOCKER_SOCKET;
}

/** Points a connection string at another database on the same server. */
function databaseUrlFor(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;

  return url.toString();
}

/** Runs the real migration runner, so tests and deployments share one path. */
async function migrate(databaseUrl: string): Promise<void> {
  const child = spawn(process.execPath, ['--experimental-strip-types', MIGRATE, 'up'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  if (code !== 0) {
    throw new Error(`Migrations failed on ${databaseUrl}:\n${output}`);
  }
}

/** `CREATE DATABASE` cannot run inside a transaction, hence a bare client. */
async function withAdminClient(
  serverUrl: string,
  work: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: serverUrl });
  await client.connect();

  try {
    await work(client);
  } finally {
    await client.end();
  }
}

export default async function globalSetup(globalConfig: { maxWorkers: number }): Promise<void> {
  let serverUrl = process.env.TEST_DATABASE_URL;

  if (!serverUrl) {
    configureDockerEndpoint();

    const container = await new PostgreSqlContainer('postgres:17-alpine').start();
    globalThis.__POSTGRES_CONTAINER__ = container;
    serverUrl = container.getConnectionUri();
  }

  await withAdminClient(serverUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}"`);
    await client.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
  });

  await migrate(databaseUrlFor(serverUrl, TEMPLATE_DATABASE));

  /**
   * One database per Jest worker.
   *
   * Suites run in parallel processes against a single server. A shared
   * database would make `resetDatabase()` unusable — truncating in one worker
   * would delete rows another worker is mid-assertion on. A database per
   * worker keeps the parallelism and makes a reset a local, safe operation.
   *
   * Cloning beats migrating N times: Postgres copies the template's files.
   */
  const workers = Math.max(globalConfig.maxWorkers, 1);
  const urls: string[] = [];

  await withAdminClient(serverUrl, async (client) => {
    for (let worker = 1; worker <= workers; worker++) {
      const database = `ticketing_w${worker}`;

      await client.query(`DROP DATABASE IF EXISTS "${database}"`);
      await client.query(`CREATE DATABASE "${database}" TEMPLATE "${TEMPLATE_DATABASE}"`);

      urls.push(databaseUrlFor(serverUrl, database));
    }
  });

  // Read by test/setup-env.ts in each worker. Jest forks its workers after
  // this returns, so they inherit the value.
  process.env.TEST_WORKER_DATABASE_URLS = JSON.stringify(urls);
}
