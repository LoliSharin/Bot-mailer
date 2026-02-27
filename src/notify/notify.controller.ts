import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalSecretGuard } from '../auth/guards/internal-secret.guard';
import { TelegramService } from '../telegram/telegram.service';
import { NotifyDto } from './dto/notify.dto';

@Controller('notify')
@UseGuards(InternalSecretGuard)
export class NotifyController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post()
  async notify(@Body() dto: NotifyDto) {
    const ok = await this.telegramService.sendNotify(dto);
    return { ok };
  }
}
