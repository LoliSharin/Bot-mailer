import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { throwError } from 'rxjs';
import { SiteApiService } from '../site-api/site-api.service';
import { TelegramService } from './telegram.service';

describe('TelegramService disconnect handling', () => {
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
