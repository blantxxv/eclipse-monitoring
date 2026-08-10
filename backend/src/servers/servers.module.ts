import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { JwtAuthModule } from '../auth/jwt-auth.module';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';
@Module({ imports: [DbModule, JwtAuthModule], controllers: [ServersController], providers: [ServersService], exports: [ServersService] })
export class ServersModule {}
