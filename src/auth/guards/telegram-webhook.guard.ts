import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class TelegramWebhookGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedSecret = this.configService.get<string>('WEBHOOK_SECRET');
    if (!expectedSecret) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedSecret = this.getHeaderValue(
      request.headers['x-telegram-bot-api-secret-token'],
    );

    if (providedSecret !== expectedSecret) {
      throw new UnauthorizedException('Invalid Telegram webhook secret');
    }

    return true;
  }

  private getHeaderValue(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }

    return value ?? '';
  }
}
