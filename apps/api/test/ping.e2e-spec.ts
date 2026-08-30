import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { READINESS_PROBE, type ReadinessProbe } from '../src/health/domain/readiness-probe.port.js';

describe('Health endpoints (e2e)', () => {
  let app: INestApplication;
  let databaseReachable = true;

  beforeAll(async () => {
    // Required config is seeded by test/setup-env.ts — it has to be in place
    // before AppModule is imported, not merely before it is compiled.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // No real Postgres in this suite: the point is the HTTP contract, and
      // the port makes substituting a fake trivial.
      .overrideProvider(READINESS_PROBE)
      .useValue({ isReachable: () => Promise.resolve(databaseReachable) } satisfies ReadinessProbe)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /ping', () => {
    it('returns 200 with a status body', async () => {
      const response = await request(app.getHttpServer()).get('/ping').expect(200);

      expect(response.body).toEqual({
        status: expect.stringMatching(/^(ok|degraded)$/) as unknown as string,
        uptimeSeconds: expect.any(Number) as unknown as number,
      });
    });

    it('stays 200 even when the database is down — liveness is not readiness', async () => {
      databaseReachable = false;
      await request(app.getHttpServer()).get('/ping').expect(200);
      databaseReachable = true;
    });
  });

  describe('GET /ready', () => {
    it('returns 200 when the database is reachable', async () => {
      databaseReachable = true;

      const response = await request(app.getHttpServer()).get('/ready').expect(200);

      expect(response.body).toEqual({ ready: true, dependencies: { database: 'up' } });
    });

    it('returns 503 when the database is unreachable', async () => {
      databaseReachable = false;

      const response = await request(app.getHttpServer()).get('/ready').expect(503);

      expect(response.body).toEqual({ ready: false, dependencies: { database: 'down' } });
    });
  });
});
