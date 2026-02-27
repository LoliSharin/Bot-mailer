import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InternalSecretGuard } from '../auth/guards/internal-secret.guard';
import { TelegramService } from '../telegram/telegram.service';

@Controller('stats')
@UseGuards(InternalSecretGuard)
export class StatsController {
  constructor(private readonly telegramService: TelegramService) {}

  @Get()
  getStats(@Query('from') from?: string, @Query('to') to?: string) {
    return this.telegramService.getStats({ from, to });
  }
}
