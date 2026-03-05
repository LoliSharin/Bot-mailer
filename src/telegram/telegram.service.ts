import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
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
  duplicateUpdatesSkipped: number;
  incomingTextMessages: number;
  incomingUnsupportedMessages: number;
  relayedToSite: number;
  relayAmbiguousContext: number;
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
  activeLinkedChats: number;
  inactiveLinkedChats: number;
  persistenceEnabled: boolean;
  stateBackend: StateBackend;
  stateFilePath?: string;
};

type LinkedUserState = {
  userId?: string;
  isActive: boolean;
  linkedAt: string;
  updatedAt: string;
  disconnectedAt?: string;
  lastNotified?: string;
};

type PersistedState = {
  knownChats: string[];
  replyContext: Array<{ key: string; orderId: string }>;
  activeOrdersByChat: Record<string, string[]>;
  selectedOrderByChat: Record<string, string>;
  linkedUsersByChat: Record<string, LinkedUserState>;
};

type StateBackend = 'memory' | 'file' | 'postgres';

type TelegramUserRow = {
  chat_id: string;
  site_user_id: string | null;
  is_active: boolean;
  linked_at: Date;
  updated_at: Date;
  disconnected_at: Date | null;
  last_notified: Date | null;
};

type ReplyContextRow = {
  chat_id: string;
  message_id: string;
  order_id: string;
};

type ActiveOrderRow = {
  chat_id: string;
  order_id: string;
};

type SelectedOrderRow = {
  chat_id: string;
  order_id: string;
};

type KnownChatRow = {
  chat_id: string;
};

@Injectable()
export class TelegramService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly startedAt = new Date();

  private readonly knownChats = new Set<string>();
  private readonly replyContext = new Map<string, string>();
  private readonly activeOrdersByChat = new Map<string, Set<string>>();
  private readonly selectedOrderByChat = new Map<string, string>();
  private readonly linkedUsersByChat = new Map<string, LinkedUserState>();
  private readonly processedUpdateIds = new Set<number>();
  private readonly processingUpdateIds = new Set<number>();
  private readonly processedUpdateOrder: number[] = [];

  private readonly maxReplyContextEntries: number;
  private readonly maxProcessedUpdateEntries: number;
  private readonly filePersistenceEnabled: boolean;
  private readonly stateFilePath: string;
  private readonly shouldAttemptPostgres: boolean;
  private readonly databaseUrl?: string;
  private readonly stateReady: Promise<void>;

  private stateBackend: StateBackend = 'memory';
  private postgresPool?: Pool;
  private persistenceQueue: Promise<void> = Promise.resolve();

  private readonly stats = {
    webhookUpdates: 0,
    duplicateUpdatesSkipped: 0,
    incomingTextMessages: 0,
    incomingUnsupportedMessages: 0,
    relayedToSite: 0,
    relayAmbiguousContext: 0,
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
  ) {
    const isTestEnv =
      process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);
    const persistenceDisabledByEnv =
      this.configService.get<string>('STATE_PERSISTENCE_DISABLED') === 'true';

    this.filePersistenceEnabled = !isTestEnv && !persistenceDisabledByEnv;
    this.stateFilePath = resolve(
      this.configService.get<string>('STATE_FILE_PATH') ??
        `${tmpdir()}/bot-mailer/telegram-state.json`,
    );

    const maxReplyContextFromEnv = Number(
      this.configService.get<string>('MAX_REPLY_CONTEXT_ENTRIES') ?? 5000,
    );
    this.maxReplyContextEntries =
      Number.isFinite(maxReplyContextFromEnv) && maxReplyContextFromEnv > 0
        ? maxReplyContextFromEnv
        : 5000;

    const maxProcessedUpdateEntriesFromEnv = Number(
      this.configService.get<string>('MAX_PROCESSED_UPDATE_IDS') ?? 10000,
    );
    this.maxProcessedUpdateEntries =
      Number.isFinite(maxProcessedUpdateEntriesFromEnv) &&
      maxProcessedUpdateEntriesFromEnv > 0
        ? maxProcessedUpdateEntriesFromEnv
        : 10000;

    const backendPreference = (
      this.configService.get<string>('STATE_STORAGE_BACKEND') ?? 'auto'
    ).toLowerCase();
    this.databaseUrl =
      this.configService.get<string>('DATABASE_URL')?.trim() || undefined;

    if (backendPreference === 'postgres' && !this.databaseUrl) {
      this.logger.warn(
        'STATE_STORAGE_BACKEND=postgres requested, but DATABASE_URL is missing. Falling back to file/memory backend.',
      );
    }

    this.shouldAttemptPostgres =
      !isTestEnv &&
      Boolean(this.databaseUrl) &&
      (backendPreference === 'postgres' || backendPreference === 'auto');

    this.stateReady = this.loadState();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.postgresPool) {
      await this.postgresPool.end();
    }
  }

  async handleUpdate(update: TelegramUpdateDto): Promise<void> {
    await this.stateReady;
    this.stats.webhookUpdates += 1;

    const updateId = Number(update.update_id);
    if (!Number.isFinite(updateId)) {
      return;
    }

    if (this.hasSeenUpdate(updateId)) {
      this.stats.duplicateUpdatesSkipped += 1;
      return;
    }

    this.processingUpdateIds.add(updateId);
    let shouldRememberUpdate = false;
    try {
      await this.processUpdate(update);
      shouldRememberUpdate = true;
    } finally {
      this.processingUpdateIds.delete(updateId);
      if (shouldRememberUpdate) {
        this.rememberProcessedUpdate(updateId);
      }
    }
  }

  private async processUpdate(update: TelegramUpdateDto): Promise<void> {
    const message = update.message ?? update.edited_message;
    if (!message) {
      return;
    }

    const chatId = String(message.chat.id);
    this.rememberChat(chatId);

    if (message.text?.startsWith('/start')) {
      await this.handleStartCommand(message);
      return;
    }

    if (message.text?.startsWith('/chat')) {
      await this.handleChatCommand(chatId, message.text);
      return;
    }

    if (message.text) {
      this.stats.incomingTextMessages += 1;

      if (!this.isLinkedAndActive(chatId)) {
        await this.sendText(
          chatId,
          'Сначала подключите Telegram в личном кабинете OneSelJob и запустите бота по ссылке из настроек.',
        );
        return;
      }

      const orderId = this.resolveOrderId(
        chatId,
        message.reply_to_message?.message_id,
      );

      if (!orderId) {
        if (this.hasAmbiguousOrderContext(chatId)) {
          this.stats.relayAmbiguousContext += 1;
        }

        await this.sendText(
          chatId,
          'Не удалось определить заказ. Укажите контекст командой /chat <orderId> или ответьте на сообщение по нужному заказу.',
        );
        return;
      }

      const forwarded = await this.siteApiService.forwardMessageFromTelegram({
        chatId,
        text: message.text,
        orderId,
      });

      if (forwarded.ok) {
        this.stats.relayedToSite += 1;
      } else {
        this.stats.relayFailed += 1;
        if (forwarded.reason === 'http' && forwarded.status === 404) {
          await this.sendText(
            chatId,
            'Заказ не найден или вам недоступен этот диалог. Проверьте номер заказа и выберите контекст заново: /chat <orderId>.',
          );
          return;
        }

        if (forwarded.reason === 'http' && forwarded.status === 403) {
          await this.sendText(
            chatId,
            'У вас нет прав писать в этот чат заказа. Проверьте, что заказ принадлежит вашему аккаунту.',
          );
          return;
        }

        await this.sendText(
          chatId,
          'Сообщение получено, но его не удалось отправить на веб-сайт. Пожалуйста, повторите попытку позже.',
        );
      }
      return;
    }

    if (message.voice || message.photo || message.document || message.video) {
      this.stats.incomingUnsupportedMessages += 1;
      await this.sendText(
        chatId,
        'Файлы и голосовые сообщения пока не поддерживаются в bot relay. Пожалуйста, отправляйте их через чат на сайте.',
      );
    }
  }
  async sendNotify(dto: NotifyDto): Promise<boolean> {
    await this.stateReady;

    const fallbackText = `Событие: ${dto.event}`;
    const dataText = dto.data ? `\n${JSON.stringify(dto.data)}` : '';
    const text = dto.text ?? `${fallbackText}${dataText}`;

    this.rememberChat(dto.chatId);

    const result = await this.sendTextDetailed(dto.chatId, text);
    if (result.ok) {
      this.stats.notifySent += 1;
      this.touchLastNotified(dto.chatId);
    } else {
      this.stats.notifyFailed += 1;
      await this.handlePotentialDisconnect(dto.chatId, result.errorCode);
    }

    return result.ok;
  }

  async sendChatRelay(dto: ChatMessageDto): Promise<boolean> {
    await this.stateReady;
    this.rememberChat(dto.chatId);

    const text = `Заказ #${dto.orderId}\nОт: ${dto.from}\n\n${dto.text}`;
    const result = await this.sendTextDetailed(dto.chatId, text);

    if (result.ok) {
      this.stats.chatSent += 1;
      this.touchLastNotified(dto.chatId);

      if (result.messageId) {
        this.setReplyContext(dto.chatId, result.messageId, dto.orderId);
      }

      this.addActiveOrder(dto.chatId, dto.orderId);
    } else {
      this.stats.chatFailed += 1;
      await this.handlePotentialDisconnect(dto.chatId, result.errorCode);
    }

    return result.ok;
  }

  async disconnectUser(chatId: string): Promise<boolean> {
    await this.stateReady;
    this.markChatInactive(chatId);
    this.clearChatContext(chatId);

    await this.sendDisconnectNotice(chatId);
    return true;
  }

  async sendDisconnectNotice(chatId: string): Promise<boolean> {
    await this.stateReady;

    const result = await this.sendTextDetailed(
      chatId,
      'Уведомления в Telegram были отключены. Вы можете повторно подключиться в настройках веб-сайта.',
    );

    if (result.ok) {
      this.stats.disconnectSent += 1;
      this.touchLastNotified(chatId);
    } else {
      this.stats.disconnectFailed += 1;
    }

    return result.ok;
  }
  async sendBroadcast(
    dto: BroadcastDto,
  ): Promise<{ total: number; sent: number; failed: number }> {
    await this.stateReady;
    const chatIds = this.resolveBroadcastTargets(dto);
    let sent = 0;
    let failed = 0;

    for (const chatId of chatIds) {
      const result = await this.sendTextDetailed(chatId, dto.message);
      if (result.ok) {
        sent += 1;
        this.stats.broadcastSent += 1;
        this.touchLastNotified(chatId);
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
      activeLinkedChats: Array.from(this.linkedUsersByChat.values()).filter(
        (user) => user.isActive,
      ).length,
      inactiveLinkedChats: Array.from(this.linkedUsersByChat.values()).filter(
        (user) => !user.isActive,
      ).length,
      persistenceEnabled: this.stateBackend !== 'memory',
      stateBackend: this.stateBackend,
      stateFilePath:
        this.stateBackend === 'file' ? this.stateFilePath : undefined,
      ...(range ?? {}),
    };
  }

  async getActiveLinkedChatIds(): Promise<string[]> {
    await this.stateReady;
    return Array.from(this.linkedUsersByChat.entries())
      .filter(([, userState]) =>
        Boolean(userState.userId && userState.isActive),
      )
      .map(([chatId]) => chatId);
  }

  private async handleChatCommand(chatId: string, text: string): Promise<void> {
    if (!this.isLinkedAndActive(chatId)) {
      await this.sendText(
        chatId,
        'Сначала подключите Telegram в личном кабинете OneSelJob и запустите бота по ссылке из настроек.',
      );
      return;
    }

    const rawArgument = text.slice('/chat'.length).trim();
    if (!rawArgument) {
      const selectedOrderId = this.getSelectedOrder(chatId);
      if (selectedOrderId) {
        await this.sendText(
          chatId,
          `Текущий активный заказ: ${selectedOrderId}. Чтобы сбросить контекст, отправьте /chat stop.`,
        );
      } else {
        await this.sendText(
          chatId,
          'Активный заказ не выбран. Укажите его командой /chat <orderId>.',
        );
      }
      return;
    }

    if (rawArgument.toLowerCase() === 'stop') {
      this.clearChatContext(chatId);
      await this.sendText(
        chatId,
        'Контекст заказа сброшен. Чтобы продолжить переписку, выберите заказ: /chat <orderId>.',
      );
      return;
    }

    const orderId = rawArgument.trim();
    if (orderId.length < 1 || orderId.length > 64) {
      await this.sendText(
        chatId,
        'Некорректный orderId. Используйте значение длиной от 1 до 64 символов.',
      );
      return;
    }

    this.setSelectedOrder(chatId, orderId);
    this.addActiveOrder(chatId, orderId);
    await this.sendText(
      chatId,
      `Активный чат установлен: заказ ${orderId}. Теперь отправляйте сообщения обычным текстом.`,
    );
  }
  private async handleStartCommand(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const payload = message.text?.split(' ')[1]?.trim();

    if (!payload) {
      await this.sendText(
        chatId,
        'Авторизуйтесь через сайт: https://oneselfjob.com',
      );
      return;
    }

    if (!payload.startsWith('link_')) {
      await this.sendText(
        chatId,
        'Недопустимый формат ссылки. Создайте новую ссылку на веб-сайте.',
      );
      return;
    }

    const token = payload.replace('link_', '');
    const result = await this.siteApiService.resolveLinkToken(token);
    if (!result) {
      await this.sendText(
        chatId,
        'Ссылка недействительна или срок её действия истёк. Создайте новую ссылку в настройках профиля.',
      );
      return;
    }

    this.setLinkedUser(chatId, result.userId);

    await this.sendText(
      chatId,
      'Telegram успешно подключён. Измените настройки уведомлений в своём профиле на веб-сайте.',
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
          `Telegram API error for chat ${chatId}: ${errorCode ?? 'n/a'} ${error.message}`,
        );
        return { ok: false, errorCode };
      }

      this.logger.warn(
        `Telegram API error for chat ${chatId}: ${(error as Error).message}`,
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

    const selectedOrderId = this.selectedOrderByChat.get(chatId);
    if (selectedOrderId) {
      return selectedOrderId;
    }

    const activeOrders = this.activeOrdersByChat.get(chatId);
    if (!activeOrders || activeOrders.size !== 1) {
      return undefined;
    }

    const [singleOrder] = Array.from(activeOrders);
    return singleOrder;
  }

  private hasAmbiguousOrderContext(chatId: string): boolean {
    const activeOrders = this.activeOrdersByChat.get(chatId);
    return Boolean(activeOrders && activeOrders.size > 1);
  }

  private resolveBroadcastTargets(dto: BroadcastDto): string[] {
    if (dto.chatIds && dto.chatIds.length > 0) {
      return Array.from(
        new Set(
          dto.chatIds.map((chatId) => String(chatId).trim()).filter(Boolean),
        ),
      ).filter((chatId) => !this.isChatInactive(chatId));
    }

    if (dto.segment === 'all_known') {
      return Array.from(this.knownChats).filter(
        (chatId) => !this.isChatInactive(chatId),
      );
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
      this.markChatInactive(chatId);
      this.clearChatContext(chatId);
      await this.siteApiService.markUserDisconnected(chatId);
    }
  }

  private hasSeenUpdate(updateId: number): boolean {
    return (
      this.processedUpdateIds.has(updateId) ||
      this.processingUpdateIds.has(updateId)
    );
  }

  private rememberProcessedUpdate(updateId: number): void {
    if (this.processedUpdateIds.has(updateId)) {
      return;
    }

    this.processedUpdateIds.add(updateId);
    this.processedUpdateOrder.push(updateId);

    while (this.processedUpdateOrder.length > this.maxProcessedUpdateEntries) {
      const oldestUpdateId = this.processedUpdateOrder.shift();
      if (oldestUpdateId !== undefined) {
        this.processedUpdateIds.delete(oldestUpdateId);
      }
    }
  }

  private rememberChat(chatId: string): void {
    const before = this.knownChats.size;
    this.knownChats.add(chatId);
    if (this.knownChats.size !== before) {
      this.schedulePersistState();
    }
  }

  private touchLastNotified(chatId: string): void {
    const userState = this.linkedUsersByChat.get(chatId);
    if (!userState) {
      return;
    }

    const now = new Date().toISOString();
    this.linkedUsersByChat.set(chatId, {
      ...userState,
      lastNotified: now,
      updatedAt: now,
    });
    this.schedulePersistState();
  }

  private setLinkedUser(chatId: string, userId: string): void {
    const now = new Date().toISOString();
    const current = this.linkedUsersByChat.get(chatId);

    this.linkedUsersByChat.set(chatId, {
      userId,
      isActive: true,
      linkedAt: current?.linkedAt ?? now,
      updatedAt: now,
      disconnectedAt: undefined,
      lastNotified: current?.lastNotified,
    });
    this.schedulePersistState();
  }

  private setReplyContext(
    chatId: string,
    messageId: number,
    orderId: string,
  ): void {
    this.replyContext.set(this.replyKey(chatId, messageId), orderId);
    this.trimReplyContext();
    this.schedulePersistState();
  }

  private setSelectedOrder(chatId: string, orderId: string): void {
    const before = this.selectedOrderByChat.get(chatId);
    if (before === orderId) {
      return;
    }

    this.selectedOrderByChat.set(chatId, orderId);
    this.schedulePersistState();
  }

  private getSelectedOrder(chatId: string): string | undefined {
    return this.selectedOrderByChat.get(chatId);
  }

  private addActiveOrder(chatId: string, orderId: string): void {
    const activeOrders =
      this.activeOrdersByChat.get(chatId) ?? new Set<string>();
    const before = activeOrders.size;
    activeOrders.add(orderId);
    this.activeOrdersByChat.set(chatId, activeOrders);

    if (activeOrders.size !== before) {
      this.schedulePersistState();
    }
  }

  private isChatInactive(chatId: string): boolean {
    return this.linkedUsersByChat.get(chatId)?.isActive === false;
  }

  private isLinkedAndActive(chatId: string): boolean {
    const userState = this.linkedUsersByChat.get(chatId);
    return Boolean(userState?.userId && userState.isActive);
  }

  private markChatInactive(chatId: string): void {
    const now = new Date().toISOString();
    const current = this.linkedUsersByChat.get(chatId);

    this.linkedUsersByChat.set(chatId, {
      userId: current?.userId,
      isActive: false,
      linkedAt: current?.linkedAt ?? now,
      updatedAt: now,
      disconnectedAt: now,
      lastNotified: current?.lastNotified,
    });
    this.schedulePersistState();
  }

  private clearChatContext(chatId: string): void {
    let hasChanges = false;

    if (this.activeOrdersByChat.delete(chatId)) {
      hasChanges = true;
    }

    const prefix = `${chatId}:`;
    for (const key of Array.from(this.replyContext.keys())) {
      if (key.startsWith(prefix)) {
        this.replyContext.delete(key);
        hasChanges = true;
      }
    }

    if (this.selectedOrderByChat.delete(chatId)) {
      hasChanges = true;
    }

    if (hasChanges) {
      this.schedulePersistState();
    }
  }

  private trimReplyContext(): void {
    while (this.replyContext.size > this.maxReplyContextEntries) {
      const oldestKey = this.replyContext.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) {
        return;
      }
      this.replyContext.delete(oldestKey);
    }
  }

  private async loadState(): Promise<void> {
    if (this.shouldAttemptPostgres) {
      const loadedFromPostgres = await this.tryInitializePostgres();
      if (loadedFromPostgres) {
        this.stateBackend = 'postgres';
        return;
      }
    }

    if (this.filePersistenceEnabled) {
      this.loadStateFromFile();
      this.stateBackend = 'file';
      return;
    }

    this.stateBackend = 'memory';
  }

  private async tryInitializePostgres(): Promise<boolean> {
    if (!this.databaseUrl) {
      return false;
    }

    try {
      this.postgresPool = new Pool({
        connectionString: this.databaseUrl,
      });

      await this.postgresPool.query('SELECT 1');
      await this.ensurePostgresSchema(this.postgresPool);
      await this.loadStateFromPostgres(this.postgresPool);

      return true;
    } catch (error) {
      this.logger.warn(
        `Failed to initialize PostgreSQL backend for Telegram state: ${(error as Error).message}`,
      );

      if (this.postgresPool) {
        await this.postgresPool.end();
      }
      this.postgresPool = undefined;
      return false;
    }
  }

  private loadStateFromFile(): void {
    if (!existsSync(this.stateFilePath)) {
      return;
    }

    try {
      const raw = readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;

      this.applyPersistedState(parsed);
    } catch (error) {
      this.logger.warn(
        `Failed to load Telegram state from file: ${(error as Error).message}`,
      );
    }
  }

  private async loadStateFromPostgres(pool: Pool): Promise<void> {
    const [
      knownChatsResult,
      replyContextResult,
      activeOrdersResult,
      selectedOrdersResult,
      usersResult,
    ] = await Promise.all([
      pool.query<KnownChatRow>(
        'SELECT chat_id FROM telegram_known_chats ORDER BY chat_id ASC',
      ),
      pool.query<ReplyContextRow>(
        'SELECT chat_id, message_id, order_id FROM telegram_reply_context ORDER BY created_at ASC',
      ),
      pool.query<ActiveOrderRow>(
        'SELECT chat_id, order_id FROM telegram_active_orders',
      ),
      pool.query<SelectedOrderRow>(
        'SELECT chat_id, order_id FROM telegram_selected_order',
      ),
      pool.query<TelegramUserRow>(
        'SELECT chat_id, site_user_id, is_active, linked_at, updated_at, disconnected_at, last_notified FROM telegram_users',
      ),
    ]);

    const snapshot: PersistedState = {
      knownChats: knownChatsResult.rows.map((row) => row.chat_id),
      replyContext: replyContextResult.rows.map((row) => ({
        key: this.replyKey(row.chat_id, Number(row.message_id)),
        orderId: row.order_id,
      })),
      activeOrdersByChat: {},
      selectedOrderByChat: {},
      linkedUsersByChat: {},
    };

    for (const row of activeOrdersResult.rows) {
      const orders = snapshot.activeOrdersByChat[row.chat_id] ?? [];
      orders.push(row.order_id);
      snapshot.activeOrdersByChat[row.chat_id] = orders;
    }

    for (const row of selectedOrdersResult.rows) {
      snapshot.selectedOrderByChat[row.chat_id] = row.order_id;
    }

    for (const row of usersResult.rows) {
      snapshot.linkedUsersByChat[row.chat_id] = {
        userId: row.site_user_id ?? undefined,
        isActive: row.is_active,
        linkedAt: row.linked_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        disconnectedAt: row.disconnected_at?.toISOString(),
        lastNotified: row.last_notified?.toISOString(),
      };
    }

    this.applyPersistedState(snapshot);
  }

  private applyPersistedState(state: PersistedState): void {
    this.knownChats.clear();
    this.replyContext.clear();
    this.activeOrdersByChat.clear();
    this.selectedOrderByChat.clear();
    this.linkedUsersByChat.clear();

    for (const chatId of state.knownChats ?? []) {
      this.knownChats.add(String(chatId));
    }

    for (const item of state.replyContext ?? []) {
      if (item?.key && item?.orderId) {
        this.replyContext.set(item.key, item.orderId);
      }
    }

    for (const [chatId, orders] of Object.entries(
      state.activeOrdersByChat ?? {},
    )) {
      this.activeOrdersByChat.set(chatId, new Set(orders.map(String)));
    }

    for (const [chatId, orderId] of Object.entries(
      state.selectedOrderByChat ?? {},
    )) {
      const normalizedOrderId = String(orderId);
      if (normalizedOrderId) {
        this.selectedOrderByChat.set(chatId, normalizedOrderId);
      }
    }

    for (const [chatId, userState] of Object.entries(
      state.linkedUsersByChat ?? {},
    )) {
      if (userState?.linkedAt && userState?.updatedAt) {
        this.linkedUsersByChat.set(chatId, userState);
      }
    }

    this.trimReplyContext();
  }

  private schedulePersistState(): void {
    if (this.stateBackend === 'memory') {
      return;
    }

    this.persistenceQueue = this.persistenceQueue
      .then(() => this.persistState())
      .catch((error) => {
        this.logger.warn(
          `Failed to persist Telegram state: ${(error as Error).message}`,
        );
      });
  }

  private async persistState(): Promise<void> {
    if (this.stateBackend === 'postgres' && this.postgresPool) {
      await this.persistStateToPostgres(this.postgresPool);
      return;
    }

    if (this.stateBackend === 'file') {
      this.persistStateToFile();
    }
  }

  private persistStateToFile(): void {
    const serialized = this.snapshotState();

    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true });
      writeFileSync(this.stateFilePath, JSON.stringify(serialized, null, 2), {
        encoding: 'utf-8',
      });
    } catch (error) {
      this.logger.warn(
        `Failed to persist Telegram state to file: ${(error as Error).message}`,
      );
    }
  }

  private async persistStateToPostgres(pool: Pool): Promise<void> {
    const snapshot = this.snapshotState();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query('DELETE FROM telegram_reply_context');
      await client.query('DELETE FROM telegram_active_orders');
      await client.query('DELETE FROM telegram_selected_order');
      await client.query('DELETE FROM telegram_known_chats');
      await client.query('DELETE FROM telegram_users');

      for (const chatId of snapshot.knownChats) {
        await client.query(
          'INSERT INTO telegram_known_chats (chat_id, updated_at) VALUES ($1, NOW())',
          [chatId],
        );
      }

      for (const item of snapshot.replyContext) {
        const [chatId, messageIdRaw] = item.key.split(':');
        const messageId = Number(messageIdRaw);
        if (!chatId || !Number.isFinite(messageId)) {
          continue;
        }

        await client.query(
          'INSERT INTO telegram_reply_context (chat_id, message_id, order_id) VALUES ($1, $2, $3)',
          [chatId, messageId, item.orderId],
        );
      }

      for (const [chatId, orders] of Object.entries(
        snapshot.activeOrdersByChat,
      )) {
        for (const orderId of orders) {
          await client.query(
            'INSERT INTO telegram_active_orders (chat_id, order_id) VALUES ($1, $2)',
            [chatId, orderId],
          );
        }
      }

      for (const [chatId, orderId] of Object.entries(
        snapshot.selectedOrderByChat,
      )) {
        await client.query(
          'INSERT INTO telegram_selected_order (chat_id, order_id, updated_at) VALUES ($1, $2, NOW())',
          [chatId, orderId],
        );
      }

      for (const [chatId, userState] of Object.entries(
        snapshot.linkedUsersByChat,
      )) {
        await client.query(
          `INSERT INTO telegram_users (
            chat_id,
            site_user_id,
            is_active,
            linked_at,
            updated_at,
            disconnected_at,
            last_notified
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            chatId,
            userState.userId ?? null,
            userState.isActive,
            userState.linkedAt,
            userState.updatedAt,
            userState.disconnectedAt ?? null,
            userState.lastNotified ?? null,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private snapshotState(): PersistedState {
    return {
      knownChats: Array.from(this.knownChats),
      replyContext: Array.from(this.replyContext.entries()).map(
        ([key, orderId]) => ({ key, orderId }),
      ),
      activeOrdersByChat: Object.fromEntries(
        Array.from(this.activeOrdersByChat.entries()).map(
          ([chatId, orders]) => [chatId, Array.from(orders)],
        ),
      ),
      selectedOrderByChat: Object.fromEntries(this.selectedOrderByChat),
      linkedUsersByChat: Object.fromEntries(this.linkedUsersByChat.entries()),
    };
  }

  private async ensurePostgresSchema(pool: Pool | PoolClient): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_users (
        chat_id TEXT PRIMARY KEY,
        site_user_id TEXT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disconnected_at TIMESTAMPTZ NULL,
        last_notified TIMESTAMPTZ NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_known_chats (
        chat_id TEXT PRIMARY KEY,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_active_orders (
        chat_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chat_id, order_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_selected_order (
        chat_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_reply_context (
        chat_id TEXT NOT NULL,
        message_id BIGINT NOT NULL,
        order_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chat_id, message_id)
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_telegram_reply_context_created_at
      ON telegram_reply_context (created_at)
    `);
  }
}
