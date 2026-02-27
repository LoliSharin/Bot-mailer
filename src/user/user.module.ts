import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { UserController } from './user.controller';

@Module({
  imports: [AuthModule, TelegramModule],
  controllers: [UserController],
})
export class UserModule {}
