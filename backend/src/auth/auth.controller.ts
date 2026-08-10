import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
class LoginDto { email: string; password: string; }
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login') login(@Body() body: LoginDto, @Req() req: Request) {
    return this.auth.login(body.email, body.password, req.ip, String(req.headers['user-agent'] || ''));
  }
  @Get('me') @UseGuards(JwtAuthGuard) me(@Req() req: any) { return { user: req.user }; }
}
