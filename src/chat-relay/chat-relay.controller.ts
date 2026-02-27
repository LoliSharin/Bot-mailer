import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalSecretGuard } from '../auth/guards/internal-secret.guard';
import { TelegramService } from '../telegram/telegram.service';
import { ChatMessageDto } from './dto/chat-message.dto';

@Controller('chat')
@UseGuards(InternalSecretGuard)
export class ChatRelayController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('message')
  async sendChatMessage(@Body() dto: ChatMessageDto) {
    const ok = await this.telegramService.sendChatRelay(dto);
    return { ok };
  }
}
