import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

type ResolveLinkResponse = {
  userId: string;
};

@Injectable()
export class SiteApiService {
  private readonly logger = new Logger(SiteApiService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async resolveLinkToken(token: string): Promise<ResolveLinkResponse | null> {
    const baseUrl = this.configService.get<string>('SITE_API_URL');
    if (!baseUrl) {
      this.logger.warn('SITE_API_URL is not configured');
      return null;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<ResolveLinkResponse>(`${baseUrl}/api/link`, {
          params: { token },
          headers: this.getInternalHeaders(),
        }),
      );

      return response.data;
    } catch (error) {
      this.logger.warn(
        `Не удалось разрешить маркер ссылки: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async forwardMessageFromTelegram(payload: {
    chatId: string;
    text: string;
    orderId?: string;
  }): Promise<boolean> {
    const baseUrl = this.configService.get<string>('SITE_API_URL');
    if (!baseUrl) {
      this.logger.warn(
        'SITE_API_URL если он не настроен, пропустите ретрансляцию чата на сайт',
      );
      return false;
    }

    try {
      await firstValueFrom(
        this.httpService.post(`${baseUrl}/api/chat/from-telegram`, payload, {
          headers: this.getInternalHeaders(),
        }),
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Не удалось передать сообщение из Telegram: ${(error as Error).message}`,
      );
      return false;
    }
  }

  async markUserDisconnected(chatId: string): Promise<void> {
    const baseUrl = this.configService.get<string>('SITE_API_URL');
    if (!baseUrl) {
      return;
    }

    try {
      await firstValueFrom(
        this.httpService.post(
          `${baseUrl}/api/telegram/disconnected`,
          { chatId },
          { headers: this.getInternalHeaders() },
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Не удалось пометить пользователя отключенным на сайте: ${(error as Error).message}`,
      );
    }
  }

  private getInternalHeaders(): Record<string, string> {
    const secret = this.configService.get<string>('SITE_API_SECRET') ?? '';

    return {
      'x-site-api-secret': secret,
    };
  }
}
