import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { BroadcastDto } from '../broadcast/dto/broadcast.dto';
import { ChatMessageDto } from '../chat-relay/dto/chat-message.dto';
import { NotifyDto } from '../notify/dto/notify.dto';
import { SiteApiService } from '../site-api/site-api.service';
import { TelegramMessage, TelegramUpdateDto } from './dto/telegram-update.dto';

type SendResult = {
  ok: boolean;
  messageId?: number;
  errorCode?: number;
};

type RuntimeStats = {
  startedAt: string;
  webhookUpdates: number;
  incomingTextMessages: number;
  incomingUnsupportedMessages: number;
  relayedToSite: number;
  relayFailed: number;
  notifySent: number;
  notifyFailed: number;
  chatSent: number;
  chatFailed: number;
  disconnectSent: number;
  disconnectFailed: number;
  broadcastSent: number;
  broadcastFailed: number;
  knownChats: number;
  replyContextSize: number;
};

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly startedAt = new Date();

  private readonly knownChats = new Set<string>();
  private readonly replyContext = new Map<string, string>();
  private readonly activeOrdersByChat = new Map<string, Set<string>>();

  private readonly stats = {
    webhookUpdates: 0,
    incomingTextMessages: 0,
    incomingUnsupportedMessages: 0,
    relayedToSite: 0,
    relayFailed: 0,
    notifySent: 0,
    notifyFailed: 0,
    chatSent: 0,
    chatFailed: 0,
    disconnectSent: 0,
    disconnectFailed: 0,
    broadcastSent: 0,
    broadcastFailed: 0,
  };

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly siteApiService: SiteApiService,
  ) {}

  async handleUpdate(update: TelegramUpdateDto): Promise<void> {
    this.stats.webhookUpdates += 1;

    const message = update.message ?? update.edited_message;
    if (!message) {
      return;
    }

    const chatId = String(message.chat.id);
    this.knownChats.add(chatId);

    if (message.text?.startsWith('/start')) {
      await this.handleStartCommand(message);
      return;
    }

    if (message.text) {
      this.stats.incomingTextMessages += 1;

      const orderId = this.resolveOrderId(
        chatId,
        message.reply_to_message?.message_id,
      );
      const forwarded = await this.siteApiService.forwardMessageFromTelegram({
        chatId,
        text: message.text,
        orderId,
      });

      if (forwarded) {
        this.stats.relayedToSite += 1;
      } else {
        this.stats.relayFailed += 1;
        await this.sendText(
          chatId,
          'Сообщение получено, но не доставлено на сайт. Пожалуйста, повторите попытку позже',
        );
      }
      return;
    }

    if (message.voice || message.photo || message.document || message.video) {
      this.stats.incomingUnsupportedMessages += 1;
      await this.sendText(
        chatId,
        'Файлы и голос не поддерживаются в bot relay. Пожалуйста, присылайте их через чат на сайте',
      );
    }
  }

  async sendNotify(dto: NotifyDto): Promise<boolean> {
    const fallbackText = `Event: ${dto.event}`;
    const dataText = dto.data ? `\n${JSON.stringify(dto.data)}` : '';
    const text = dto.text ?? `${fallbackText}${dataText}`;

    this.knownChats.add(dto.chatId);

    const result = await this.sendTextDetailed(dto.chatId, text);
    if (result.ok) {
      this.stats.notifySent += 1;
    } else {
      this.stats.notifyFailed += 1;
      await this.handlePotentialDisconnect(dto.chatId, result.errorCode);
    }

    return result.ok;
  }

  async sendChatRelay(dto: ChatMessageDto): Promise<boolean> {
    this.knownChats.add(dto.chatId);

    const text = `Order #${dto.orderId}\nFrom: ${dto.from}\n\n${dto.text}`;
    const result = await this.sendTextDetailed(dto.chatId, text);

    if (result.ok) {
      this.stats.chatSent += 1;
      if (result.messageId) {
        this.replyContext.set(
          this.replyKey(dto.chatId, result.messageId),
          dto.orderId,
        );
      }
      const activeOrders =
        this.activeOrdersByChat.get(dto.chatId) ?? new Set<string>();
      activeOrders.add(dto.orderId);
      this.activeOrdersByChat.set(dto.chatId, activeOrders);
    } else {
      this.stats.chatFailed += 1;
      await this.handlePotentialDisconnect(dto.chatId, result.errorCode);
    }

    return result.ok;
  }

  async sendDisconnectNotice(chatId: string): Promise<boolean> {
    const result = await this.sendTextDetailed(
      chatId,
      'Уведомления в Telegram были отключены. Вы можете повторно подключиться в настройках веб-сайта',
    );

    if (result.ok) {
      this.stats.disconnectSent += 1;
    } else {
      this.stats.disconnectFailed += 1;
    }

    return result.ok;
  }

  async sendBroadcast(
    dto: BroadcastDto,
  ): Promise<{ total: number; sent: number; failed: number }> {
    const chatIds = this.resolveBroadcastTargets(dto);
    let sent = 0;
    let failed = 0;

    for (const chatId of chatIds) {
      const result = await this.sendTextDetailed(chatId, dto.message);
      if (result.ok) {
        sent += 1;
        this.stats.broadcastSent += 1;
      } else {
        failed += 1;
        this.stats.broadcastFailed += 1;
        await this.handlePotentialDisconnect(chatId, result.errorCode);
      }
    }

    return {
      total: chatIds.length,
      sent,
      failed,
    };
  }

  getStats(range?: { from?: string; to?: string }): RuntimeStats {
    return {
      startedAt: this.startedAt.toISOString(),
      ...this.stats,
      knownChats: this.knownChats.size,
      replyContextSize: this.replyContext.size,
      ...(range ?? {}),
    };
  }

  private async handleStartCommand(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const payload = message.text?.split(' ')[1]?.trim();

    if (!payload) {
      await this.sendText(
        chatId,
        'Ссылка на бота указана в настройках профиля на веб-сайте. Используйте "Подключить Telegram" там же',
      );
      return;
    }

    if (!payload.startsWith('link_')) {
      await this.sendText(
        chatId,
        'Неверный формат ссылки. Создайте новую ссылку на веб-сайте.',
      );
      return;
    }

    const token = payload.replace('link_', '');
    const result = await this.siteApiService.resolveLinkToken(token);
    if (!result) {
      await this.sendText(
        chatId,
        'Ссылка недействительна или срок ее действия истек. Создайте новую ссылку в настройках профиля',
      );
      return;
    }

    await this.sendText(
      chatId,
      'Telegram успешно подключен. Настройте настройки уведомлений в своем профиле на веб-сайте',
    );
  }

  private async sendText(chatId: string, text: string): Promise<boolean> {
    const result = await this.sendTextDetailed(chatId, text);
    return result.ok;
  }

  private async sendTextDetailed(
    chatId: string,
    text: string,
  ): Promise<SendResult> {
    const botToken = this.configService.get<string>('BOT_TOKEN');
    if (!botToken) {
      this.logger.warn(
        `BOT_TOKEN is not configured, skip sending message to ${chatId}`,
      );
      return { ok: false };
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          },
        ),
      );

      const responseData = response.data as {
        result?: { message_id?: number };
      };
      const messageId = responseData.result?.message_id;
      return { ok: true, messageId };
    } catch (error) {
      if (isAxiosError(error)) {
        const errorCode = error.response?.status;
        this.logger.warn(
          `Ошибка Telegram API для чата ${chatId}: ${errorCode ?? 'n/a'} ${error.message}`,
        );
        return { ok: false, errorCode };
      }

      this.logger.warn(
        `Ошибка Telegram API для чата ${chatId}: ${(error as Error).message}`,
      );
      return { ok: false };
    }
  }

  private resolveOrderId(
    chatId: string,
    replyToMessageId?: number,
  ): string | undefined {
    if (replyToMessageId) {
      const orderId = this.replyContext.get(
        this.replyKey(chatId, replyToMessageId),
      );
      if (orderId) {
        return orderId;
      }
    }

    const activeOrders = this.activeOrdersByChat.get(chatId);
    if (!activeOrders || activeOrders.size !== 1) {
      return undefined;
    }

    const [singleOrder] = Array.from(activeOrders);
    return singleOrder;
  }

  private resolveBroadcastTargets(dto: BroadcastDto): string[] {
    if (dto.chatIds && dto.chatIds.length > 0) {
      return Array.from(
        new Set(
          dto.chatIds.map((chatId) => String(chatId).trim()).filter(Boolean),
        ),
      );
    }

    if (dto.segment === 'all_known') {
      return Array.from(this.knownChats);
    }

    return [];
  }

  private replyKey(chatId: string, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  private async handlePotentialDisconnect(
    chatId: string,
    errorCode?: number,
  ): Promise<void> {
    if (errorCode === 403) {
      await this.siteApiService.markUserDisconnected(chatId);
    }
  }
}
