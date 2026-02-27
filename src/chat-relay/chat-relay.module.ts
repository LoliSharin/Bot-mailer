import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ChatRelayController } from './chat-relay.controller';

@Module({
  imports: [AuthModule, TelegramModule],
  controllers: [ChatRelayController],
})
export class ChatRelayModule {}
