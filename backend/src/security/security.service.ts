import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { sendTelegramMessage, editTelegramMessage, answerCallbackQuery, escapeHtml } from '../common/telegram.util';

const RELOAD_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class SecurityService implements OnModuleInit {
  private blocked = new Set<string>();
  constructor(private readonly db: DbService, private readonly settings: SettingsService) {}

  async onModuleInit() {
    await this.reloadBlocked();
    setInterval(() => { this.reloadBlocked().catch((e) => console.error('reload blocked ips failed:', e)); }, RELOAD_INTERVAL_MS);
  }

  private async reloadBlocked() {
    const r = await this.db.query('select ip from blocked_ips');
    this.blocked = new Set(r.rows.map((x) => x.ip));
  }

  isBlocked(ip: string) { return Boolean(ip) && this.blocked.has(ip); }

  async listBlocked() {
    const r = await this.db.query('select ip,reason,blocked_at,blocked_by from blocked_ips order by blocked_at desc');
    return r.rows;
  }

  async blockIp(ip: string, reason: string, blockedBy: string) {
    if (!ip) return;
    await this.db.query(
      `insert into blocked_ips(ip,reason,blocked_by) values($1,$2,$3) on conflict (ip) do update set reason=$2,blocked_by=$3,blocked_at=now()`,
      [ip, reason || null, blockedBy || null],
    );
    this.blocked.add(ip);
  }

  async unblockIp(ip: string) {
    await this.db.query('delete from blocked_ips where ip=$1', [ip]);
    this.blocked.delete(ip);
  }

  async authLog(limit = 20, offset = 0) {
    const lim = Math.min(100, Math.max(1, limit));
    const off = Math.max(0, offset);
    const r = await this.db.query(
      'select id,email,ip,success,user_agent,created_at from auth_attempts order by created_at desc limit $1 offset $2',
      [lim + 1, off],
    );
    const hasMore = r.rows.length > lim;
    return { items: r.rows.slice(0, lim), hasMore };
  }

  async recordAndNotify(email: string, ip: string, userAgent: string, success: boolean) {
    await this.db.query('insert into auth_attempts(email,ip,success,user_agent) values($1,$2,$3,$4)', [email || null, ip || null, success, userAgent || null]);

    const cfg = await this.settings.getInternal();
    if (!cfg.botToken || !cfg.chatIds.length) return;

    const already = this.isBlocked(ip);
    const status = success ? '✅ Успешный вход в панель' : '⚠️ Неудачная попытка входа в панель';
    const text = [
      status,
      `Email: ${escapeHtml(email || '—')}`,
      `IP: ${escapeHtml(ip || '—')}${already ? ' (уже заблокирован)' : ''}`,
      `Время: ${escapeHtml(new Date().toLocaleString('ru-RU'))}`,
      `User-Agent: ${escapeHtml((userAgent || '—').slice(0, 200))}`,
    ].join('\n');

    const keyboard = ip && !already ? [[{ text: `🚫 Заблокировать ${ip}`, callback_data: `block:${ip}` }]] : undefined;
    await sendTelegramMessage(cfg.botToken, cfg.chatIds, text, keyboard);
  }

  async handleWebhookUpdate(update: any) {
    const cq = update?.callback_query;
    if (!cq || typeof cq.data !== 'string') return;

    const cfg = await this.settings.getInternal();
    if (!cfg.botToken) return;

    const chatId = cq.message?.chat?.id;
    const isAdmin = chatId !== undefined && chatId !== null && cfg.chatIds.includes(String(chatId));
    if (!isAdmin) { await answerCallbackQuery(cfg.botToken, cq.id, 'Недоступно.'); return; }

    const [action, ip] = String(cq.data).split(':');
    if (action !== 'block' || !ip) { await answerCallbackQuery(cfg.botToken, cq.id); return; }

    await this.blockIp(ip, 'Заблокирован из Telegram', String(chatId));
    await answerCallbackQuery(cfg.botToken, cq.id, `IP ${ip} заблокирован`);

    if (cq.message?.message_id) {
      const originalText = String(cq.message.text || '').split('\n\n🚫')[0];
      await editTelegramMessage(cfg.botToken, chatId, cq.message.message_id, `${escapeHtml(originalText)}\n\n🚫 <b>IP ${escapeHtml(ip)} заблокирован</b>`);
    }
  }
}
