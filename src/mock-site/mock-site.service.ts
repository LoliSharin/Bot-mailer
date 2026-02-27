import { Injectable } from '@nestjs/common';

type ChatMessage = {
  chatId: string;
  text: string;
  orderId?: string;
  createdAt: string;
};

@Injectable()
export class MockSiteService {
  private readonly validTokens = new Map<string, string>([
    ['valid-token', 'test-user-1'],
    ['valid-token-2', 'test-user-2'],
  ]);

  private readonly messages: ChatMessage[] = [];
  private readonly disconnectedUsers: string[] = [];

  resolveLinkToken(token: string): { userId: string } | null {
    const userId = this.validTokens.get(token);
    if (!userId) {
      return null;
    }

    return { userId };
  }

  saveFromTelegram(payload: {
    chatId: string;
    text: string;
    orderId?: string;
  }): { ok: true } {
    this.messages.push({
      ...payload,
      createdAt: new Date().toISOString(),
    });

    return { ok: true };
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
}
