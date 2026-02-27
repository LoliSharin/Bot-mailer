import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { TelegramWebhookGuard } from '../auth/guards/telegram-webhook.guard';
import type { TelegramUpdateDto } from './dto/telegram-update.dto';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(private readonly telegramService: TelegramService) {}

  @Post('webhook')
  @UseGuards(TelegramWebhookGuard)
  async handleWebhook(@Body() update: Record<string, unknown>) {
    const parsedUpdate = update as unknown as TelegramUpdateDto;
    this.logger.debug(`Incoming update_id=${parsedUpdate.update_id}`);
    await this.telegramService.handleUpdate(parsedUpdate);
    return { ok: true };
  }
}
