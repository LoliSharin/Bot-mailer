import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { SiteApiService } from './site-api.service';

@Module({
  imports: [HttpModule],
  providers: [SiteApiService],
  exports: [SiteApiService],
})
export class SiteApiModule {}
