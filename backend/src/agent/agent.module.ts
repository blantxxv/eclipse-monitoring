import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ServersModule } from '../servers/servers.module';
import { AgentController } from './agent.controller';
@Module({ imports: [DbModule, ServersModule], controllers: [AgentController] })
export class AgentModule {}
