/// <reference types="jest" />
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createServer } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

type ForwardMode = 'legacy' | 'order_path';

describe('App e2e', () => {
  const findFreePort = async (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Failed to resolve free port'));
          return;
        }

        const { port } = address;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
      });
    });

  const createApp = async (forwardMode: ForwardMode = 'legacy') => {
    const port = await findFreePort();

    process.env.PORT = String(port);
    process.env.BOT_TOKEN = '';
    process.env.SITE_API_SECRET = 'test-secret';
    process.env.WEBHOOK_SECRET = 'test-webhook';
    process.env.SITE_API_URL = `http://127.0.0.1:${port}`;
    process.env.SITE_CHAT_FORWARD_MODE = forwardMode;
    process.env.SITE_CHAT_ORDER_PATH_TEMPLATE = '/api/chat/{orderId}/message';
    process.env.SITE_CHAT_FORWARD_MAX_ATTEMPTS = '1';
    process.env.SITE_CHAT_FORWARD_BASE_DELAY_MS = '1';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app: INestApplication<App> = moduleFixture.createNestApplication();
    await app.listen(port);
    return app;
  };

  const postTelegramWebhook = (
    app: INestApplication<App>,
    body: Record<string, unknown>,
  ) => {
    return request(app.getHttpServer())
      .post('/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'test-webhook')
      .send(body)
      .expect(201)
      .expect({ ok: true });
  };

  it('/health (GET)', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      const body = response.body as { status: string; timestamp: string };
      expect(body.status).toBe('ok');
      expect(typeof body.timestamp).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('/telegram/webhook (POST) returns 401 with invalid secret', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .post('/telegram/webhook')
        .set('x-telegram-bot-api-secret-token', 'bad-secret')
        .send({ update_id: 1 })
        .expect(401);
    } finally {
      await app.close();
    }
  });

  it('/telegram/webhook (POST) returns ok with valid secret', async () => {
    const app = await createApp();
    try {
      await postTelegramWebhook(app, { update_id: 1 });
    } finally {
      await app.close();
    }
  });

  it('/notify (POST) requires internal secret', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .post('/notify')
        .send({ chatId: '1', event: 'test' })
        .expect(401);
    } finally {
      await app.close();
    }
  });

  it('/notify (POST) accepts request with internal secret', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .post('/notify')
        .set('x-site-api-secret', 'test-secret')
        .send({ chatId: '1', event: 'test' })
        .expect(201)
        .expect({ ok: false });
    } finally {
      await app.close();
    }
  });

  it('/chat/message (POST) requires internal secret', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .post('/chat/message')
        .send({ chatId: '1', orderId: 'o-1', from: 'client', text: 'hello' })
        .expect(401);
    } finally {
      await app.close();
    }
  });

  it('/chat/message (POST) accepts request with internal secret', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .post('/chat/message')
        .set('x-site-api-secret', 'test-secret')
        .send({ chatId: '1', orderId: 'o-1', from: 'client', text: 'hello' })
        .expect(201)
        .expect({ ok: false });
    } finally {
      await app.close();
    }
  });

  it('/api/link (GET) returns user for valid token', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .get('/api/link')
        .query({ token: 'valid-token' })
        .expect(200)
        .expect({ userId: 'test-user-1' });
    } finally {
      await app.close();
    }
  });

  it('/api/link (GET) returns 404 for invalid token', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .get('/api/link')
        .query({ token: 'bad-token' })
        .expect(404);
    } finally {
      await app.close();
    }
  });

  it('/broadcast (POST) processes request with internal secret', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .post('/broadcast')
        .set('x-site-api-secret', 'test-secret')
        .send({ chatIds: ['1', '2'], message: 'hello' })
        .expect(201)
        .expect({ total: 2, sent: 0, failed: 2 });
    } finally {
      await app.close();
    }
  });

  it('/stats (GET) returns runtime stats', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .get('/stats')
        .set('x-site-api-secret', 'test-secret')
        .expect(200);

      const body = response.body as { startedAt: string; knownChats: number };
      expect(typeof body.startedAt).toBe('string');
      expect(typeof body.knownChats).toBe('number');
    } finally {
      await app.close();
    }
  });

  it('/user/:chatId (DELETE) requires internal secret', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer()).delete('/user/1').expect(401);
    } finally {
      await app.close();
    }
  });

  it('/user/:chatId (DELETE) disconnects user with internal secret', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .delete('/user/1')
        .set('x-site-api-secret', 'test-secret')
        .expect(200)
        .expect({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('webhook /chat <orderId> + text forwards message with orderId (legacy mode)', async () => {
    const app = await createApp('legacy');
    try {
      await postTelegramWebhook(app, {
        update_id: 10,
        message: {
          message_id: 10,
          text: '/start link_valid-token',
          chat: { id: 1001, type: 'private' },
        },
      });

      await postTelegramWebhook(app, {
        update_id: 11,
        message: {
          message_id: 11,
          text: '/chat 123',
          chat: { id: 1001, type: 'private' },
        },
      });

      await postTelegramWebhook(app, {
        update_id: 12,
        message: {
          message_id: 12,
          text: 'hello from tg',
          chat: { id: 1001, type: 'private' },
        },
      });

      const messagesResponse = await request(app.getHttpServer())
        .get('/api/chat/messages')
        .expect(200);

      const messages = messagesResponse.body as Array<{
        chatId: string;
        text: string;
        orderId?: string;
      }>;

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          chatId: '1001',
          text: 'hello from tg',
          orderId: '123',
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('webhook /chat stop clears context and blocks forwarding without new order selection', async () => {
    const app = await createApp('legacy');
    try {
      await postTelegramWebhook(app, {
        update_id: 20,
        message: {
          message_id: 20,
          text: '/start link_valid-token',
          chat: { id: 1002, type: 'private' },
        },
      });

      await postTelegramWebhook(app, {
        update_id: 21,
        message: {
          message_id: 21,
          text: '/chat 777',
          chat: { id: 1002, type: 'private' },
        },
      });

      await postTelegramWebhook(app, {
        update_id: 22,
        message: {
          message_id: 22,
          text: '/chat stop',
          chat: { id: 1002, type: 'private' },
        },
      });

      await postTelegramWebhook(app, {
        update_id: 23,
        message: {
          message_id: 23,
          text: 'should not be forwarded',
          chat: { id: 1002, type: 'private' },
        },
      });

      const messagesResponse = await request(app.getHttpServer())
        .get('/api/chat/messages')
        .expect(200);

      const messages = messagesResponse.body as Array<{ text: string }>;
      expect(messages).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('order_path mode forwards via /api/chat/:orderId/message', async () => {
    const app = await createApp('order_path');
    try {
      await postTelegramWebhook(app, {
        update_id: 30,
        message: {
          message_id: 30,
          text: '/start link_valid-token',
          chat: { id: 1003, type: 'private' },
        },
      });

      await postTelegramWebhook(app, {
        update_id: 31,
        message: {
          message_id: 31,
          text: '/chat order-path-1',
          chat: { id: 1003, type: 'private' },
        },
      });

      await postTelegramWebhook(app, {
        update_id: 32,
        message: {
          message_id: 32,
          text: 'hello path contract',
          chat: { id: 1003, type: 'private' },
        },
      });

      const messagesResponse = await request(app.getHttpServer())
        .get('/api/chat/messages')
        .expect(200);

      const messages = messagesResponse.body as Array<{
        chatId: string;
        text: string;
        orderId?: string;
      }>;

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          chatId: '1003',
          text: 'hello path contract',
          orderId: 'order-path-1',
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('skips duplicated webhook update_id and forwards message only once', async () => {
    const app = await createApp('legacy');
    try {
      await postTelegramWebhook(app, {
        update_id: 40,
        message: {
          message_id: 40,
          text: '/start link_valid-token',
          chat: { id: 1004, type: 'private' },
        },
      });

      await postTelegramWebhook(app, {
        update_id: 41,
        message: {
          message_id: 41,
          text: '/chat 501',
          chat: { id: 1004, type: 'private' },
        },
      });

      const duplicatedPayload = {
        update_id: 42,
        message: {
          message_id: 42,
          text: 'duplicate message',
          chat: { id: 1004, type: 'private' },
        },
      };

      await postTelegramWebhook(app, duplicatedPayload);
      await postTelegramWebhook(app, duplicatedPayload);

      const messagesResponse = await request(app.getHttpServer())
        .get('/api/chat/messages')
        .expect(200);

      const messages = messagesResponse.body as Array<{
        chatId: string;
        text: string;
        orderId?: string;
      }>;

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          chatId: '1004',
          text: 'duplicate message',
          orderId: '501',
        }),
      );
    } finally {
      await app.close();
    }
  });
});
