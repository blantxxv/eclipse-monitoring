import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DbService } from '../db/db.service';
import { SecurityService } from '../security/security.service';
@Injectable()
export class AuthService {
  constructor(private readonly db: DbService, private readonly jwt: JwtService, private readonly security: SecurityService) {}
  async login(email: string, password: string, ip: string, userAgent: string) {
    const result = await this.db.query('select id,email,password_hash,role from users where email=$1', [String(email || '').toLowerCase()]);
    const user = result.rows[0];
    const ok = Boolean(user) && (await bcrypt.compare(password || '', user.password_hash));

    await this.security.recordAndNotify(email, ip, userAgent, ok).catch((e) => console.error('auth notify failed:', e));

    if (!ok) throw new UnauthorizedException('invalid credentials');
    return { access_token: this.jwt.sign({ sub: user.id, email: user.email, role: user.role }), user: { id: user.id, email: user.email, role: user.role } };
  }
}
