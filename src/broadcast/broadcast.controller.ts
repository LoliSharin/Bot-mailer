import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalSecretGuard } from '../auth/guards/internal-secret.guard';
import { TelegramService } from '../telegram/telegram.service';
import { BroadcastDto } from './dto/broadcast.dto';

@Controller('broadcast')
@UseGuards(InternalSecretGuard)
export class BroadcastController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post()
  async broadcast(@Body() dto: BroadcastDto) {
    return this.telegramService.sendBroadcast(dto);
  }
}
