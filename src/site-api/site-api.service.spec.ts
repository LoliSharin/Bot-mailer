import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { SiteApiService } from './site-api.service';

describe('SiteApiService', () => {
  let service: SiteApiService;
  let httpServiceMock: { get: jest.Mock; post: jest.Mock };
  let configServiceMock: { get: jest.Mock };

  beforeEach(async () => {
    httpServiceMock = {
      get: jest.fn(),
      post: jest.fn(),
    };

    configServiceMock = {
      get: jest.fn(),
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
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return undefined;
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      return undefined;
    });

    const result = await service.resolveLinkToken('any-token');

    expect(result).toBeNull();
    expect(httpServiceMock.get).not.toHaveBeenCalled();
  });

  it('resolves token through site api', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return 'http://localhost:3000';
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      return undefined;
    });

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
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return undefined;
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      return undefined;
    });

    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
      orderId: 'o-1',
    });

    expect(result).toEqual({ ok: false, reason: 'config' });
    expect(httpServiceMock.post).not.toHaveBeenCalled();
  });

  it('uses legacy contract by default', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return 'http://localhost:3000';
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      if (key === 'SITE_CHAT_FORWARD_MODE') {
        return undefined;
      }
      return undefined;
    });

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
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return 'http://localhost:3000';
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      if (key === 'SITE_CHAT_FORWARD_MODE') {
        return 'order_path';
      }
      if (key === 'SITE_CHAT_ORDER_PATH_TEMPLATE') {
        return '/api/chat/{orderId}/message';
      }
      return undefined;
    });

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

  it('returns http error details when relay fails with response status', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return 'http://localhost:3000';
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      return undefined;
    });

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
  });

  it('returns network error when relay fails without http response', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return 'http://localhost:3000';
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      return undefined;
    });

    httpServiceMock.post.mockReturnValue(
      throwError(() => new Error('connection refused')),
    );

    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
      orderId: 'o-1',
    });

    expect(result).toEqual({ ok: false, reason: 'network' });
  });
});
