import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { JwtAuthModule } from '../auth/jwt-auth.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
@Module({ imports: [DbModule, JwtAuthModule], controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
