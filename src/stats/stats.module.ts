import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { StatsController } from './stats.controller';

@Module({
  imports: [AuthModule, TelegramModule],
  controllers: [StatsController],
})
export class StatsModule {}
