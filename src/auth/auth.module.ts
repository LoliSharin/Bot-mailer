import { Module } from '@nestjs/common';
import { InternalSecretGuard } from './guards/internal-secret.guard';
import { TelegramWebhookGuard } from './guards/telegram-webhook.guard';

@Module({
  providers: [InternalSecretGuard, TelegramWebhookGuard],
  exports: [InternalSecretGuard, TelegramWebhookGuard],
})
export class AuthModule {}
