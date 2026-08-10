import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { SettingsModule } from '../settings/settings.module';
import { JwtAuthModule } from '../auth/jwt-auth.module';
import { SecurityController } from './security.controller';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { SecurityService } from './security.service';

@Module({
  imports: [DbModule, SettingsModule, JwtAuthModule],
  controllers: [SecurityController, TelegramWebhookController],
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
