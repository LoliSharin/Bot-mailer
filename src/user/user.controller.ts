import { Controller, Delete, Param, UseGuards } from '@nestjs/common';
import { InternalSecretGuard } from '../auth/guards/internal-secret.guard';
import { TelegramService } from '../telegram/telegram.service';

@Controller('user')
@UseGuards(InternalSecretGuard)
export class UserController {
  constructor(private readonly telegramService: TelegramService) {}

  @Delete(':chatId')
  async removeUser(@Param('chatId') chatId: string) {
    const ok = await this.telegramService.sendDisconnectNotice(chatId);
    return { ok };
  }
}
