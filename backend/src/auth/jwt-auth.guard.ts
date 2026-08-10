import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) throw new UnauthorizedException('missing token');
    try { req.user = this.jwt.verify(auth.slice(7), { secret: process.env.JWT_SECRET || 'change_me' }); return true; }
    catch { throw new UnauthorizedException('invalid token'); }
  }
}
