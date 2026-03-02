import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { SiteApiService } from '../site-api/site-api.service';
import { TelegramService } from './telegram.service';

describe('TelegramService', () => {
  let service: TelegramService;
  let httpServiceMock: { post: jest.Mock };
  let configServiceMock: { get: jest.Mock };
  let siteApiServiceMock: {
    resolveLinkToken: jest.Mock;
    forwardMessageFromTelegram: jest.Mock;
    markUserDisconnected: jest.Mock;
  };

  beforeEach(async () => {
    httpServiceMock = {
      post: jest.fn(),
    };

    configServiceMock = {
      get: jest.fn(),
    };

    siteApiServiceMock = {
      resolveLinkToken: jest.fn(),
      forwardMessageFromTelegram: jest.fn(),
      markUserDisconnected: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramService,
        { provide: HttpService, useValue: httpServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: SiteApiService, useValue: siteApiServiceMock },
      ],
    }).compile();

    service = module.get<TelegramService>(TelegramService);
  });

  it('returns false and does not call Telegram API when BOT_TOKEN is missing', async () => {
    configServiceMock.get.mockReturnValue(undefined);

    const result = await service.sendNotify({
      chatId: '123',
      event: 'test_event',
      text: 'test text',
    });

    expect(result).toBe(false);
    expect(httpServiceMock.post).not.toHaveBeenCalled();
  });

  it('sends message to Telegram API when BOT_TOKEN is configured', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'BOT_TOKEN') {
        return 'token123';
      }
      return undefined;
    });

    httpServiceMock.post.mockReturnValue(of({ data: { ok: true } }));

    const result = await service.sendNotify({
      chatId: '123',
      event: 'test_event',
      text: 'hello',
    });

    expect(result).toBe(true);
    expect(httpServiceMock.post).toHaveBeenCalledTimes(1);
    expect(httpServiceMock.post).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken123/sendMessage',
      expect.objectContaining({
        chat_id: '123',
        text: 'hello',
      }),
    );
  });

  it('forwards non-command text update to site api', async () => {
    siteApiServiceMock.forwardMessageFromTelegram.mockResolvedValue(true);

    await service.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        text: 'plain text',
        chat: { id: 777, type: 'private' },
      },
    });

    expect(siteApiServiceMock.forwardMessageFromTelegram).toHaveBeenCalledWith({
      chatId: '777',
      text: 'plain text',
    });
  });

  it('marks user as disconnected when Telegram API returns 403', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'BOT_TOKEN') {
        return 'token123';
      }
      return undefined;
    });

    httpServiceMock.post.mockReturnValue(
      throwError(() => ({
        isAxiosError: true,
        message: 'forbidden',
        response: { status: 403 },
      })),
    );

    const result = await service.sendNotify({
      chatId: '123',
      event: 'test_event',
      text: 'hello',
    });

    expect(result).toBe(false);
    expect(siteApiServiceMock.markUserDisconnected).toHaveBeenCalledWith('123');
  });
});
