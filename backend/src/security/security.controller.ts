import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SecurityService } from './security.service';

@Controller('api/security') @UseGuards(JwtAuthGuard)
export class SecurityController {
  constructor(private readonly security: SecurityService) {}
  @Get('auth-log') authLog(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.security.authLog(Number(limit) || 20, Number(offset) || 0);
  }
  @Get('blocked-ips') blocked() { return this.security.listBlocked(); }
  @Post('blocked-ips') async block(@Body() body: { ip: string; reason?: string }) {
    await this.security.blockIp(String(body?.ip || '').trim(), body?.reason || 'Заблокирован вручную', 'panel');
    return this.security.listBlocked();
  }
  @Delete('blocked-ips/:ip') async unblock(@Param('ip') ip: string) {
    await this.security.unblockIp(ip);
    return this.security.listBlocked();
  }
}
