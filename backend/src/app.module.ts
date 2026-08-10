import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { ServersModule } from './servers/servers.module';
import { AgentModule } from './agent/agent.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SettingsModule } from './settings/settings.module';
import { AlertsModule } from './alerts/alerts.module';
import { SecurityModule } from './security/security.module';
import { SystemModule } from './system/system.module';

@Module({
  imports: [
    JwtModule.register({ secret: process.env.JWT_SECRET || 'change_me', signOptions: { expiresIn: '12h' } }),
    DbModule,
    AuthModule,
    ServersModule,
    AgentModule,
    DashboardModule,
    SettingsModule,
    AlertsModule,
    SecurityModule,
    SystemModule,
  ],
})
export class AppModule {}
