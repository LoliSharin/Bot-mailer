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
  let configValues: Record<string, string | undefined>;

  const createTextUpdate = (
    text: string,
    chatId = 777,
    messageId = 10,
    replyToMessageId?: number,
  ) => ({
    update_id: messageId,
    message: {
      message_id: messageId,
      text,
      chat: { id: chatId, type: 'private' as const },
      ...(replyToMessageId
        ? { reply_to_message: { message_id: replyToMessageId } }
        : {}),
    },
  });

  const linkChat = async (chatId = 777) => {
    siteApiServiceMock.resolveLinkToken.mockResolvedValue({ userId: 'u-1' });
    await service.handleUpdate(
      createTextUpdate('/start link_valid-token', chatId, 1),
    );
  };

  beforeEach(async () => {
    httpServiceMock = {
      post: jest.fn(),
    };

    configValues = {
      BOT_TOKEN: undefined,
      DATABASE_URL: undefined,
      STATE_STORAGE_BACKEND: undefined,
      STATE_FILE_PATH: undefined,
      MAX_REPLY_CONTEXT_ENTRIES: undefined,
      MAX_PROCESSED_UPDATE_IDS: undefined,
      STATE_PERSISTENCE_DISABLED: undefined,
    };

    configServiceMock = {
      get: jest.fn((key: string) => configValues[key]),
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
    const result = await service.sendNotify({
      chatId: '123',
      event: 'test_event',
      text: 'test text',
    });

    expect(result).toBe(false);
    expect(httpServiceMock.post).not.toHaveBeenCalled();
  });

  it('sends message to Telegram API when BOT_TOKEN is configured', async () => {
    configValues.BOT_TOKEN = 'token123';
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
      expect.objectContaining({ timeout: 10000 }),
    );
  });

  it('does not forward text from non-linked chat', async () => {
    siteApiServiceMock.forwardMessageFromTelegram.mockResolvedValue({
      ok: true,
    });

    await service.handleUpdate(createTextUpdate('plain text'));

    expect(
      siteApiServiceMock.forwardMessageFromTelegram,
    ).not.toHaveBeenCalled();
  });

  it('sets sticky order via /chat and then forwards regular text with this order', async () => {
    siteApiServiceMock.forwardMessageFromTelegram.mockResolvedValue({
      ok: true,
    });

    await linkChat();
    await service.handleUpdate(createTextUpdate('/chat 123', 777, 2));

    expect(
      siteApiServiceMock.forwardMessageFromTelegram,
    ).not.toHaveBeenCalled();

    await service.handleUpdate(createTextUpdate('plain text', 777, 3));

    expect(siteApiServiceMock.forwardMessageFromTelegram).toHaveBeenCalledWith({
      chatId: '777',
      text: 'plain text',
      orderId: '123',
    });
  });

  it('skips duplicate webhook updates by update_id', async () => {
    siteApiServiceMock.forwardMessageFromTelegram.mockResolvedValue({
      ok: true,
    });

    await linkChat();
    await service.handleUpdate(createTextUpdate('/chat 123', 777, 2));
    siteApiServiceMock.forwardMessageFromTelegram.mockClear();

    const duplicateUpdate = createTextUpdate('dup text', 777, 50);
    await service.handleUpdate(duplicateUpdate);
    await service.handleUpdate(duplicateUpdate);

    expect(siteApiServiceMock.forwardMessageFromTelegram).toHaveBeenCalledTimes(
      1,
    );
    expect(siteApiServiceMock.forwardMessageFromTelegram).toHaveBeenCalledWith({
      chatId: '777',
      text: 'dup text',
      orderId: '123',
    });
  });

  it('returns current sticky context with /chat', async () => {
    configValues.BOT_TOKEN = 'token123';
    httpServiceMock.post.mockReturnValue(
      of({ data: { result: { message_id: 55 } } }),
    );

    await linkChat();
    await service.handleUpdate(createTextUpdate('/chat 123', 777, 2));

    httpServiceMock.post.mockClear();
    await service.handleUpdate(createTextUpdate('/chat', 777, 3));

    expect(
      siteApiServiceMock.forwardMessageFromTelegram,
    ).not.toHaveBeenCalled();
    expect(httpServiceMock.post).toHaveBeenCalledTimes(1);
    const firstCall = httpServiceMock.post.mock.calls[0] as [
      string,
      {
        chat_id: string;
        text: string;
      },
    ];
    const payload = firstCall[1];
    expect(payload).toBeDefined();
    const typedPayload = payload as {
      chat_id: string;
      text: string;
    };
    expect(typedPayload.chat_id).toBe('777');
    expect(typedPayload.text).toContain('123');
    expect(typedPayload.text).toContain('/chat stop');
  });

  it('clears sticky context with /chat stop', async () => {
    siteApiServiceMock.forwardMessageFromTelegram.mockResolvedValue({
      ok: true,
    });

    await linkChat();
    await service.handleUpdate(createTextUpdate('/chat 123', 777, 2));
    await service.handleUpdate(createTextUpdate('/chat stop', 777, 3));
    await service.handleUpdate(createTextUpdate('plain text', 777, 4));

    expect(
      siteApiServiceMock.forwardMessageFromTelegram,
    ).not.toHaveBeenCalled();
  });

  it('does not forward linked chat message without resolved order context', async () => {
    siteApiServiceMock.forwardMessageFromTelegram.mockResolvedValue({
      ok: true,
    });

    await linkChat();
    await service.handleUpdate(createTextUpdate('plain text', 777, 2));

    expect(
      siteApiServiceMock.forwardMessageFromTelegram,
    ).not.toHaveBeenCalled();
  });

  it('prefers reply context orderId over sticky orderId', async () => {
    configValues.BOT_TOKEN = 'token123';
    httpServiceMock.post.mockReturnValue(
      of({ data: { result: { message_id: 999 } } }),
    );
    siteApiServiceMock.forwardMessageFromTelegram.mockResolvedValue({
      ok: true,
    });

    await linkChat();
    await service.handleUpdate(createTextUpdate('/chat sticky-order', 777, 2));

    await service.sendChatRelay({
      chatId: '777',
      orderId: 'reply-order',
      from: 'client',
      text: 'incoming from site',
    });

    await service.handleUpdate(createTextUpdate('answer', 777, 3, 999));

    expect(siteApiServiceMock.forwardMessageFromTelegram).toHaveBeenCalledWith({
      chatId: '777',
      text: 'answer',
      orderId: 'reply-order',
    });
  });

  it('sends explicit message when site api returns 404 for order', async () => {
    configValues.BOT_TOKEN = 'token123';
    httpServiceMock.post.mockReturnValue(
      of({ data: { result: { message_id: 77 } } }),
    );
    siteApiServiceMock.forwardMessageFromTelegram.mockResolvedValue({
      ok: false,
      reason: 'http',
      status: 404,
    });

    await linkChat();
    await service.handleUpdate(createTextUpdate('/chat missing-order', 777, 2));

    httpServiceMock.post.mockClear();
    await service.handleUpdate(createTextUpdate('plain text', 777, 3));

    expect(siteApiServiceMock.forwardMessageFromTelegram).toHaveBeenCalledWith({
      chatId: '777',
      text: 'plain text',
      orderId: 'missing-order',
    });
    expect(httpServiceMock.post).toHaveBeenCalledTimes(1);
    const firstCall = httpServiceMock.post.mock.calls[0] as [
      string,
      {
        chat_id: string;
        text: string;
      },
    ];
    const payload = firstCall[1];
    expect(payload).toBeDefined();
    const typedPayload = payload as {
      chat_id: string;
      text: string;
    };
    expect(typedPayload.chat_id).toBe('777');
    expect(typedPayload.text).toContain('/chat <orderId>');
  });

  it('marks user as disconnected when Telegram API returns 403', async () => {
    configValues.BOT_TOKEN = 'token123';

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
