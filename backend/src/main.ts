import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import rateLimit from 'express-rate-limit';
import { SecurityService } from './security/security.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.getHttpAdapter().getInstance().set('trust proxy', true);

  const security = app.get(SecurityService);
  app.use((req: any, res: any, next: any) => {
    if (security.isBlocked(req.ip)) return res.status(403).json({ error: 'blocked' });
    next();
  });

  app.use(json({ limit: '3mb', verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(urlencoded({ extended: true }));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use('/api/auth/login', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }));
  app.enableCors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Server-Id', 'X-Timestamp', 'X-Signature'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  const port = Number(process.env.AGENT_API_PORT || 3406);
  await app.listen(port, '0.0.0.0');
  console.log(`Eclipse backend listening on 0.0.0.0:${port}`);
}
bootstrap();
