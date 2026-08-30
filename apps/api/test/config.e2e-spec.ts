import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The DoD asks for proof that *bootstrap* fails on a missing required var.
 *
 * Manipulating `process.env` inside a test cannot show this: validation runs
 * when `config.module.ts` is imported, which happens before any test body.
 * So these tests launch the real compiled entrypoint in a child process with
 * a controlled environment and assert on how it exits — exactly what a
 * container orchestrator would observe.
 *
 * Requires `pnpm build` (turbo runs it first via the task graph).
 */
const MAIN = resolve(process.cwd(), 'dist/main.js');

const BASE_ENV = {
  PATH: process.env.PATH,
  NODE_ENV: 'test',
} as NodeJS.ProcessEnv;

interface RunResult {
  code: number | null;
  output: string;
}

/** Starts the API and resolves once it exits (or when `waitForListening`). */
function runApi(env: NodeJS.ProcessEnv): {
  exited: Promise<RunResult>;
  kill: () => void;
} {
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const exited = new Promise<RunResult>((resolvePromise) => {
    child.on('close', (code) => resolvePromise({ code, output }));
  });

  return { exited, kill: () => child.kill('SIGKILL') };
}

describe('Configuration bootstrap (e2e)', () => {
  it('exits non-zero and names the variable when DATABASE_URL is missing', async () => {
    const { exited } = runApi({ ...BASE_ENV });
    const { code, output } = await exited;

    expect(code).not.toBe(0);
    expect(output).toMatch(/Invalid environment configuration/);
    expect(output).toMatch(/DATABASE_URL/);
  });

  it('exits non-zero when a variable is present but out of range', async () => {
    const { exited } = runApi({
      ...BASE_ENV,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/event_ticketing',
      PORT: '70000',
    });
    const { code, output } = await exited;

    expect(code).not.toBe(0);
    expect(output).toMatch(/PORT/);
  });

  it('rejects a DATABASE_URL that is not a postgres connection string', async () => {
    const { exited } = runApi({ ...BASE_ENV, DATABASE_URL: 'mysql://localhost:3306/db' });
    const { code, output } = await exited;

    expect(code).not.toBe(0);
    expect(output).toMatch(/postgres/);
  });

  it('starts on the configured port when the environment is valid', async () => {
    const port = 4123;
    const { exited, kill } = runApi({
      ...BASE_ENV,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/event_ticketing',
      PORT: String(port),
    });

    try {
      // Poll until it binds — proves PORT was read from config, not hardcoded.
      let response: Response | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          response = await fetch(`http://localhost:${port}/ping`);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      expect(response?.status).toBe(200);
    } finally {
      kill();
      await exited;
    }
  });
});
