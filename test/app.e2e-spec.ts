/// <reference types="jest" />
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('App e2e', () => {
  let app: INestApplication<App>;

  beforeAll(() => {
    process.env.BOT_TOKEN = '';
    process.env.SITE_API_SECRET = 'test-secret';
    process.env.WEBHOOK_SECRET = 'test-webhook';
    process.env.SITE_API_URL = 'http://localhost:3000';
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET)', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    const body = response.body as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });

  it('/telegram/webhook (POST) returns 401 with invalid secret', () => {
    return request(app.getHttpServer())
      .post('/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'bad-secret')
      .send({ update_id: 1 })
      .expect(401);
  });

  it('/telegram/webhook (POST) returns ok with valid secret', () => {
    return request(app.getHttpServer())
      .post('/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'test-webhook')
      .send({ update_id: 1 })
      .expect(201)
      .expect({ ok: true });
  });

  it('/notify (POST) requires internal secret', () => {
    return request(app.getHttpServer())
      .post('/notify')
      .send({ chatId: '1', event: 'test' })
      .expect(401);
  });

  it('/notify (POST) accepts request with internal secret', () => {
    return request(app.getHttpServer())
      .post('/notify')
      .set('x-site-api-secret', 'test-secret')
      .send({ chatId: '1', event: 'test' })
      .expect(201)
      .expect({ ok: false });
  });

  it('/api/link (GET) returns user for valid token', () => {
    return request(app.getHttpServer())
      .get('/api/link')
      .query({ token: 'valid-token' })
      .expect(200)
      .expect({ userId: 'test-user-1' });
  });

  it('/api/link (GET) returns 404 for invalid token', () => {
    return request(app.getHttpServer())
      .get('/api/link')
      .query({ token: 'bad-token' })
      .expect(404);
  });

  it('/broadcast (POST) processes request with internal secret', () => {
    return request(app.getHttpServer())
      .post('/broadcast')
      .set('x-site-api-secret', 'test-secret')
      .send({ chatIds: ['1', '2'], message: 'hello' })
      .expect(201)
      .expect({ total: 2, sent: 0, failed: 2 });
  });

  it('/stats (GET) returns runtime stats', async () => {
    const response = await request(app.getHttpServer())
      .get('/stats')
      .set('x-site-api-secret', 'test-secret')
      .expect(200);

    const body = response.body as { startedAt: string; knownChats: number };
    expect(typeof body.startedAt).toBe('string');
    expect(typeof body.knownChats).toBe('number');
  });
});
