import { Module } from '@nestjs/common';
import { MockSiteController } from './mock-site.controller';
import { MockSiteService } from './mock-site.service';

@Module({
  controllers: [MockSiteController],
  providers: [MockSiteService],
})
export class MockSiteModule {}
