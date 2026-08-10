import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { JwtAuthModule } from '../auth/jwt-auth.module';

@Module({ imports: [JwtAuthModule], controllers: [SystemController] })
export class SystemModule {}
