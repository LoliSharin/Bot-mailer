import { Injectable } from '@nestjs/common';
import { TelegramService } from '../telegram/telegram.service';

type ChatMessage = {
  chatId: string;
  text: string;
  orderId?: string;
  createdAt: string;
};

type MockOrder = {
  orderId: string;
  title: string;
  createdAt: string;
};

@Injectable()
export class MockSiteService {
  constructor(private readonly telegramService: TelegramService) {}

  private readonly validTokens = new Map<string, string>([
    ['valid-token', 'test-user-1'],
    ['valid-token-2', 'test-user-2'],
  ]);

  private readonly messages: ChatMessage[] = [];
  private readonly disconnectedUsers: string[] = [];
  private readonly orderParticipants = new Map<string, Set<string>>();
  private readonly orders = new Map<string, MockOrder>([
    [
      '123',
      {
        orderId: '123',
        title: 'Тестовый заказ для демо',
        createdAt: new Date().toISOString(),
      },
    ],
    [
      '777',
      {
        orderId: '777',
        title: 'Тестовый заказ #777',
        createdAt: new Date().toISOString(),
      },
    ],
    [
      '501',
      {
        orderId: '501',
        title: 'Тестовый заказ #501',
        createdAt: new Date().toISOString(),
      },
    ],
    [
      'order-path-1',
      {
        orderId: 'order-path-1',
        title: 'Тестовый заказ order-path-1',
        createdAt: new Date().toISOString(),
      },
    ],
  ]);

  resolveLinkToken(token: string): { userId: string } | null {
    const userId = this.validTokens.get(token);
    if (!userId) {
      return null;
    }

    return { userId };
  }

  async saveFromTelegram(payload: {
    chatId: string;
    text: string;
    orderId?: string;
  }): Promise<{ ok: true; relayed: number }> {
    this.messages.push({
      ...payload,
      createdAt: new Date().toISOString(),
    });

    const relayed = await this.relayToOrderParticipants(payload);
    return { ok: true, relayed };
  }

  async saveFromTelegramOrderPath(
    orderId: string,
    payload: { chatId: string; text: string },
  ): Promise<{ ok: true; relayed: number }> {
    return this.saveFromTelegram({ ...payload, orderId });
  }

  markDisconnected(chatId: string): { ok: true } {
    this.disconnectedUsers.push(chatId);
    return { ok: true };
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  getDisconnectedUsers(): string[] {
    return this.disconnectedUsers;
  }

  hasOrder(orderId: string): boolean {
    return this.orders.has(orderId);
  }

  createOrder(orderId: string, title?: string): MockOrder {
    const normalizedOrderId = orderId.trim();
    const existingOrder = this.orders.get(normalizedOrderId);
    if (existingOrder) {
      return existingOrder;
    }

    const order: MockOrder = {
      orderId: normalizedOrderId,
      title: title?.trim() || `Тестовый заказ #${normalizedOrderId}`,
      createdAt: new Date().toISOString(),
    };
    this.orders.set(normalizedOrderId, order);
    return order;
  }

  getOrders(): MockOrder[] {
    return Array.from(this.orders.values());
  }

  private async relayToOrderParticipants(payload: {
    chatId: string;
    text: string;
    orderId?: string;
  }): Promise<number> {
    const orderId = payload.orderId?.trim();
    if (!orderId) {
      return 0;
    }

    const participants = this.getOrCreateOrderParticipants(orderId);
    participants.add(payload.chatId);

    const participantRecipients = Array.from(participants).filter(
      (chatId) => chatId !== payload.chatId,
    );

    let recipients = participantRecipients;
    if (recipients.length === 0) {
      const activeChatIds = await this.telegramService.getActiveLinkedChatIds();
      recipients = activeChatIds.filter((chatId) => chatId !== payload.chatId);
    }

    let relayed = 0;
    for (const chatId of recipients) {
      const ok = await this.telegramService.sendChatRelay({
        chatId,
        orderId,
        from: 'Собеседник',
        text: payload.text,
      });
      if (ok) {
        relayed += 1;
        participants.add(chatId);
      }
    }

    return relayed;
  }

  private getOrCreateOrderParticipants(orderId: string): Set<string> {
    const existing = this.orderParticipants.get(orderId);
    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    this.orderParticipants.set(orderId, created);
    return created;
  }
}
