import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { JwtAuthModule } from '../auth/jwt-auth.module';
import { DashboardController } from './dashboard.controller';
@Module({ imports: [DbModule, JwtAuthModule], controllers: [DashboardController] })
export class DashboardModule {}
