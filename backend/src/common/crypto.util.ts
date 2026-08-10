import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function key() {
  return createHash('sha256').update(process.env.AGENT_SECRET_ENCRYPTION_KEY || process.env.JWT_SECRET || 'change_me').digest();
}

export function encrypt(v: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decrypt(v: string): string {
  const b = Buffer.from(v, 'base64');
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), enc = b.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}
