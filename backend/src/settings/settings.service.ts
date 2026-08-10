import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DbService } from '../db/db.service';
import { decrypt, encrypt } from '../common/crypto.util';
import { setTelegramWebhook } from '../common/telegram.util';

const DEFAULTS = {
  cpu_threshold_percent: '80',
  ram_threshold_percent: '80',
  disk_threshold_percent: '90',
  sustained_minutes: '5',
  traffic_threshold_mbps: '700',
  bridge_sessions_threshold: '8000',
  bridge_down_minutes: '5',
  vpn_monitoring: 'true',
  bridge_monitoring: 'true',
};

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(private readonly db: DbService) {}

  async onModuleInit() {
    const internal = await this.getInternal();
    if (internal.botToken) await this.registerWebhook(internal.botToken).catch((e) => console.error('webhook registration failed:', e));
  }

  private async getAll(): Promise<Record<string, string>> {
    const r = await this.db.query('select key,value from settings');
    const map: Record<string, string> = {};
    for (const row of r.rows) map[row.key] = row.value;
    return map;
  }
  private async set(key: string, value: string | null) {
    await this.db.query(`insert into settings(key,value,updated_at) values($1,$2,now()) on conflict (key) do update set value=$2,updated_at=now()`, [key, value]);
  }

  async getPublic() {
    const all = await this.getAll();
    let chatIds: string[] = [];
    try { chatIds = all.telegram_chat_ids ? JSON.parse(all.telegram_chat_ids) : []; } catch { chatIds = []; }
    return {
      telegramConfigured: Boolean(all.telegram_bot_token_enc),
      telegramChatIds: chatIds,
      vpnMonitoring: (all.vpn_monitoring ?? DEFAULTS.vpn_monitoring) !== 'false',
      bridgeMonitoring: (all.bridge_monitoring ?? DEFAULTS.bridge_monitoring) !== 'false',
      thresholds: {
        cpuPercent: Number(all.cpu_threshold_percent || DEFAULTS.cpu_threshold_percent),
        ramPercent: Number(all.ram_threshold_percent || DEFAULTS.ram_threshold_percent),
        diskPercent: Number(all.disk_threshold_percent || DEFAULTS.disk_threshold_percent),
        sustainedMinutes: Number(all.sustained_minutes || DEFAULTS.sustained_minutes),
        trafficMbps: Number(all.traffic_threshold_mbps || DEFAULTS.traffic_threshold_mbps),
        bridgeSessions: Number(all.bridge_sessions_threshold || DEFAULTS.bridge_sessions_threshold),
        bridgeDownMinutes: Number(all.bridge_down_minutes || DEFAULTS.bridge_down_minutes),
      },
    };
  }

  async getInternal() {
    const all = await this.getAll();
    let chatIds: string[] = [];
    try { chatIds = all.telegram_chat_ids ? JSON.parse(all.telegram_chat_ids) : []; } catch { chatIds = []; }
    return {
      botToken: all.telegram_bot_token_enc ? decrypt(all.telegram_bot_token_enc) : null,
      chatIds,
      cpuPercent: Number(all.cpu_threshold_percent || DEFAULTS.cpu_threshold_percent),
      ramPercent: Number(all.ram_threshold_percent || DEFAULTS.ram_threshold_percent),
      diskPercent: Number(all.disk_threshold_percent || DEFAULTS.disk_threshold_percent),
      sustainedMinutes: Number(all.sustained_minutes || DEFAULTS.sustained_minutes),
      trafficMbps: Number(all.traffic_threshold_mbps || DEFAULTS.traffic_threshold_mbps),
      bridgeSessions: Number(all.bridge_sessions_threshold || DEFAULTS.bridge_sessions_threshold),
      bridgeDownMinutes: Number(all.bridge_down_minutes || DEFAULTS.bridge_down_minutes),
      vpnMonitoring: (all.vpn_monitoring ?? DEFAULTS.vpn_monitoring) !== 'false',
      bridgeMonitoring: (all.bridge_monitoring ?? DEFAULTS.bridge_monitoring) !== 'false',
    };
  }

  async getWebhookSecret() {
    const all = await this.getAll();
    if (all.telegram_webhook_secret) return all.telegram_webhook_secret;
    const secret = randomBytes(24).toString('hex');
    await this.set('telegram_webhook_secret', secret);
    return secret;
  }

  private async registerWebhook(botToken: string) {
    const base = process.env.PANEL_PUBLIC_URL || '';
    const secret = await this.getWebhookSecret();
    await setTelegramWebhook(botToken, `${base.replace(/\/$/, '')}/api/telegram/webhook`, secret);
  }

  async setTelegramToken(token: string) {
    if (!token || token.trim().length < 10) throw new BadRequestException('invalid bot token');
    const trimmed = token.trim();
    await this.set('telegram_bot_token_enc', encrypt(trimmed));
    await this.registerWebhook(trimmed).catch((e) => console.error('webhook registration failed:', e));
    return this.getPublic();
  }
  async clearTelegramToken() { await this.set('telegram_bot_token_enc', null); return this.getPublic(); }

  async addChatId(id: string) {
    id = String(id || '').trim();
    if (!id) throw new BadRequestException('chat id is required');
    const cur = (await this.getPublic()).telegramChatIds;
    if (!cur.includes(id)) cur.push(id);
    await this.set('telegram_chat_ids', JSON.stringify(cur));
    return this.getPublic();
  }
  async removeChatId(id: string) {
    const cur = (await this.getPublic()).telegramChatIds.filter((x) => x !== id);
    await this.set('telegram_chat_ids', JSON.stringify(cur));
    return this.getPublic();
  }

  async updateThresholds(body: { cpuPercent?: number; ramPercent?: number; diskPercent?: number; sustainedMinutes?: number; trafficMbps?: number; bridgeSessions?: number; bridgeDownMinutes?: number; vpnMonitoring?: boolean; bridgeMonitoring?: boolean }) {
    if (body.vpnMonitoring !== undefined) await this.set('vpn_monitoring', body.vpnMonitoring ? 'true' : 'false');
    if (body.bridgeMonitoring !== undefined) await this.set('bridge_monitoring', body.bridgeMonitoring ? 'true' : 'false');
    if (body.cpuPercent !== undefined) await this.set('cpu_threshold_percent', String(Math.min(100, Math.max(1, Number(body.cpuPercent)))));
    if (body.ramPercent !== undefined) await this.set('ram_threshold_percent', String(Math.min(100, Math.max(1, Number(body.ramPercent)))));
    if (body.diskPercent !== undefined) await this.set('disk_threshold_percent', String(Math.min(100, Math.max(1, Number(body.diskPercent)))));
    if (body.sustainedMinutes !== undefined) await this.set('sustained_minutes', String(Math.min(60, Math.max(1, Number(body.sustainedMinutes)))));
    if (body.trafficMbps !== undefined) await this.set('traffic_threshold_mbps', String(Math.min(100_000, Math.max(1, Number(body.trafficMbps)))));
    if (body.bridgeSessions !== undefined) await this.set('bridge_sessions_threshold', String(Math.min(10_000_000, Math.max(1, Number(body.bridgeSessions)))));
    // мост-down: от 1 до 59 мин — должно быть меньше часа (в час мост уходит в «нерабочий» и мониторинг отключается).
    if (body.bridgeDownMinutes !== undefined) await this.set('bridge_down_minutes', String(Math.min(59, Math.max(1, Number(body.bridgeDownMinutes)))));
    return this.getPublic();
  }
}
