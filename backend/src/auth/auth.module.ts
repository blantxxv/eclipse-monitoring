import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { SecurityModule } from '../security/security.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthModule } from './jwt-auth.module';

@Module({
  imports: [DbModule, SecurityModule, JwtAuthModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService, JwtAuthModule],
})
export class AuthModule {}
