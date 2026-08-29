import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('GET /ping (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with a status body', async () => {
    const response = await request(app.getHttpServer()).get('/ping').expect(200);

    expect(response.body).toEqual({
      status: expect.stringMatching(/^(ok|degraded)$/) as unknown as string,
      uptimeSeconds: expect.any(Number) as unknown as number,
    });
  });
});
