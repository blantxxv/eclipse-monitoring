import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { JwtAuthModule } from '../auth/jwt-auth.module';
import { SettingsModule } from '../settings/settings.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
@Module({ imports: [DbModule, JwtAuthModule, SettingsModule], controllers: [AlertsController], providers: [AlertsService] })
export class AlertsModule {}
