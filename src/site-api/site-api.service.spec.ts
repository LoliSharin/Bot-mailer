import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { SiteApiService } from './site-api.service';

describe('SiteApiService', () => {
  let service: SiteApiService;
  let httpServiceMock: { get: jest.Mock; post: jest.Mock };
  let configServiceMock: { get: jest.Mock };
  let configValues: Record<string, string | undefined>;

  beforeEach(async () => {
    httpServiceMock = {
      get: jest.fn(),
      post: jest.fn(),
    };

    configValues = {
      SITE_API_URL: undefined,
      SITE_API_SECRET: 'secret',
      SITE_CHAT_FORWARD_MODE: undefined,
      SITE_CHAT_ORDER_PATH_TEMPLATE: undefined,
      SITE_CHAT_FORWARD_MAX_ATTEMPTS: '1',
      SITE_CHAT_FORWARD_BASE_DELAY_MS: '1',
    };

    configServiceMock = {
      get: jest.fn((key: string) => configValues[key]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SiteApiService,
        { provide: HttpService, useValue: httpServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
      ],
    }).compile();

    service = module.get<SiteApiService>(SiteApiService);
  });

  it('returns null when SITE_API_URL is missing for link resolving', async () => {
    const result = await service.resolveLinkToken('any-token');

    expect(result).toBeNull();
    expect(httpServiceMock.get).not.toHaveBeenCalled();
  });

  it('resolves token through site api', async () => {
    configValues.SITE_API_URL = 'http://localhost:3000';
    httpServiceMock.get.mockReturnValue(of({ data: { userId: 'u-1' } }));

    const result = await service.resolveLinkToken('valid-token');

    expect(result).toEqual({ userId: 'u-1' });
    expect(httpServiceMock.get).toHaveBeenCalledWith(
      'http://localhost:3000/api/link',
      expect.objectContaining({
        params: { token: 'valid-token' },
        headers: { 'x-site-api-secret': 'secret' },
      }),
    );
  });

  it('returns config error when SITE_API_URL is missing for chat relay', async () => {
    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
      orderId: 'o-1',
    });

    expect(result).toEqual({ ok: false, reason: 'config' });
    expect(httpServiceMock.post).not.toHaveBeenCalled();
  });

  it('uses legacy contract by default', async () => {
    configValues.SITE_API_URL = 'http://localhost:3000';
    httpServiceMock.post.mockReturnValue(of({ data: { ok: true } }));

    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
      orderId: 'o-1',
    });

    expect(result).toEqual({ ok: true });
    expect(httpServiceMock.post).toHaveBeenCalledWith(
      'http://localhost:3000/api/chat/from-telegram',
      {
        chatId: '123',
        text: 'hello',
        orderId: 'o-1',
      },
      expect.objectContaining({ headers: { 'x-site-api-secret': 'secret' } }),
    );
  });

  it('uses order_path contract when enabled', async () => {
    configValues.SITE_API_URL = 'http://localhost:3000';
    configValues.SITE_CHAT_FORWARD_MODE = 'order_path';
    configValues.SITE_CHAT_ORDER_PATH_TEMPLATE = '/api/chat/{orderId}/message';
    httpServiceMock.post.mockReturnValue(of({ data: { ok: true } }));

    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
      orderId: 'order-42',
    });

    expect(result).toEqual({ ok: true });
    expect(httpServiceMock.post).toHaveBeenCalledWith(
      'http://localhost:3000/api/chat/order-42/message',
      { chatId: '123', text: 'hello' },
      expect.objectContaining({ headers: { 'x-site-api-secret': 'secret' } }),
    );
  });

  it('retries transient network error and eventually succeeds', async () => {
    configValues.SITE_API_URL = 'http://localhost:3000';
    configValues.SITE_CHAT_FORWARD_MAX_ATTEMPTS = '2';
    configValues.SITE_CHAT_FORWARD_BASE_DELAY_MS = '1';

    httpServiceMock.post
      .mockReturnValueOnce(throwError(() => new Error('connection reset')))
      .mockReturnValueOnce(of({ data: { ok: true } }));

    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
      orderId: 'o-1',
    });

    expect(result).toEqual({ ok: true });
    expect(httpServiceMock.post).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 404 response', async () => {
    configValues.SITE_API_URL = 'http://localhost:3000';
    configValues.SITE_CHAT_FORWARD_MAX_ATTEMPTS = '3';

    httpServiceMock.post.mockReturnValue(
      throwError(() => ({
        isAxiosError: true,
        message: 'not found',
        response: { status: 404 },
      })),
    );

    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
      orderId: 'o-1',
    });

    expect(result).toEqual({ ok: false, reason: 'http', status: 404 });
    expect(httpServiceMock.post).toHaveBeenCalledTimes(1);
  });

  it('retries network error and returns failure after max attempts', async () => {
    configValues.SITE_API_URL = 'http://localhost:3000';
    configValues.SITE_CHAT_FORWARD_MAX_ATTEMPTS = '3';
    configValues.SITE_CHAT_FORWARD_BASE_DELAY_MS = '1';

    httpServiceMock.post.mockReturnValue(
      throwError(() => new Error('connection refused')),
    );

    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
      orderId: 'o-1',
    });

    expect(result).toEqual({ ok: false, reason: 'network' });
    expect(httpServiceMock.post).toHaveBeenCalledTimes(3);
  });
});
