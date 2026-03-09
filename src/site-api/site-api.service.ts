import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

type ResolveLinkResponse = {
  userId: string;
};

type ForwardFromTelegramPayload = {
  chatId: string;
  text: string;
  orderId?: string;
};

export type ForwardFromTelegramResult =
  | { ok: true }
  | { ok: false; status?: number; reason: 'config' | 'http' | 'network' };

type ChatForwardMode = 'legacy' | 'order_path';

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
          timeout: this.resolveSiteApiTimeoutMs(),
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

  async forwardMessageFromTelegram(
    payload: ForwardFromTelegramPayload,
  ): Promise<ForwardFromTelegramResult> {
    const baseUrlRaw = this.configService.get<string>('SITE_API_URL');
    const baseUrl = baseUrlRaw?.trim();
    if (!baseUrl) {
      this.logger.warn('SITE_API_URL is not configured');
      return { ok: false, reason: 'config' };
    }

    const mode = this.resolveChatForwardMode();
    if (mode === 'order_path' && !payload.orderId) {
      this.logger.warn(
        'order_path mode requires orderId for Telegram chat forwarding',
      );
      return { ok: false, reason: 'config' };
    }

    const endpoint =
      mode === 'order_path'
        ? this.buildOrderPathUrl(baseUrl, payload.orderId ?? '')
        : this.joinUrl(baseUrl, '/api/chat/from-telegram');
    const body =
      mode === 'order_path'
        ? { chatId: payload.chatId, text: payload.text }
        : payload;

    const maxAttempts = this.resolveForwardMaxAttempts();
    const retryDelayMs = this.resolveForwardRetryDelayMs();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await this.forwardMessageToSite(endpoint, body);
      if (result.ok) {
        return result;
      }

      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !this.shouldRetryForwardResult(result)) {
        return result;
      }

      const delay = retryDelayMs * 2 ** (attempt - 1);
      await this.sleep(delay);
    }

    return { ok: false, reason: 'network' };
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
          {
            headers: this.getInternalHeaders(),
            timeout: this.resolveSiteApiTimeoutMs(),
          },
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

  private resolveChatForwardMode(): ChatForwardMode {
    const rawMode =
      this.configService.get<string>('SITE_CHAT_FORWARD_MODE') ?? 'legacy';
    return rawMode === 'order_path' ? 'order_path' : 'legacy';
  }

  private async forwardMessageToSite(
    endpoint: string,
    body: Record<string, string | undefined>,
  ): Promise<ForwardFromTelegramResult> {
    try {
      await firstValueFrom(
        this.httpService.post(endpoint, body, {
          headers: this.getInternalHeaders(),
          timeout: this.resolveSiteApiTimeoutMs(),
        }),
      );
      return { ok: true };
    } catch (error) {
      if (isAxiosError(error)) {
        const status = error.response?.status;
        this.logger.warn(
          `Failed to relay Telegram message to site. status=${status ?? 'n/a'} message=${error.message}`,
        );
        return { ok: false, reason: 'http', status };
      }

      this.logger.warn(
        `Failed to relay Telegram message to site: ${(error as Error).message}`,
      );
      return { ok: false, reason: 'network' };
    }
  }

  private shouldRetryForwardResult(result: ForwardFromTelegramResult): boolean {
    if (result.ok) {
      return false;
    }

    if (result.reason === 'network') {
      return true;
    }

    if (result.reason !== 'http' || result.status === undefined) {
      return false;
    }

    return (
      result.status === 408 || result.status === 429 || result.status >= 500
    );
  }

  private resolveForwardMaxAttempts(): number {
    const raw = Number(
      this.configService.get<string>('SITE_CHAT_FORWARD_MAX_ATTEMPTS') ?? 3,
    );
    if (!Number.isFinite(raw) || raw < 1) {
      return 3;
    }

    return Math.min(Math.trunc(raw), 10);
  }

  private resolveForwardRetryDelayMs(): number {
    const raw = Number(
      this.configService.get<string>('SITE_CHAT_FORWARD_BASE_DELAY_MS') ?? 250,
    );
    if (!Number.isFinite(raw) || raw < 1) {
      return 250;
    }

    return Math.min(Math.trunc(raw), 2000);
  }

  private resolveSiteApiTimeoutMs(): number {
    const raw = Number(
      this.configService.get<string>('SITE_API_TIMEOUT_MS') ?? 8000,
    );
    if (!Number.isFinite(raw) || raw < 1000) {
      return 8000;
    }

    return Math.min(Math.trunc(raw), 30000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private buildOrderPathUrl(baseUrl: string, orderId: string): string {
    const templateRaw =
      this.configService.get<string>('SITE_CHAT_ORDER_PATH_TEMPLATE') ??
      '/api/chat/{orderId}/message';
    const template = templateRaw.trim();
    const normalizedTemplate = template.startsWith('/')
      ? template
      : `/${template}`;
    const path = normalizedTemplate.includes('{orderId}')
      ? normalizedTemplate.replace('{orderId}', encodeURIComponent(orderId))
      : '/api/chat/{orderId}/message'.replace(
          '{orderId}',
          encodeURIComponent(orderId),
        );

    return this.joinUrl(baseUrl, path);
  }

  private joinUrl(baseUrl: string, path: string): string {
    const normalizedBase = baseUrl.endsWith('/')
      ? baseUrl.slice(0, -1)
      : baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }
}
