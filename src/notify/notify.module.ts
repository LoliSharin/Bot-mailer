import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { NotifyController } from './notify.controller';

@Module({
  imports: [AuthModule, TelegramModule],
  controllers: [NotifyController],
})
export class NotifyModule {}
