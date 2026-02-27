import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BroadcastModule } from './broadcast/broadcast.module';
import { ChatRelayModule } from './chat-relay/chat-relay.module';
import { HealthModule } from './health/health.module';
import { MockSiteModule } from './mock-site/mock-site.module';
import { NotifyModule } from './notify/notify.module';
import { SiteApiModule } from './site-api/site-api.module';
import { StatsModule } from './stats/stats.module';
import { TelegramModule } from './telegram/telegram.module';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    AuthModule,
    SiteApiModule,
    HealthModule,
    TelegramModule,
    NotifyModule,
    BroadcastModule,
    StatsModule,
    MockSiteModule,
    ChatRelayModule,
    UserModule,
  ],
})
export class AppModule {}
