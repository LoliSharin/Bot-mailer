import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { MockSiteController } from './mock-site.controller';
import { MockSiteService } from './mock-site.service';

@Module({
  imports: [TelegramModule],
  controllers: [MockSiteController],
  providers: [MockSiteService],
})
export class MockSiteModule {}
