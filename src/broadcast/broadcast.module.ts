import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { BroadcastController } from './broadcast.controller';

@Module({
  imports: [AuthModule, TelegramModule],
  controllers: [BroadcastController],
})
export class BroadcastModule {}
