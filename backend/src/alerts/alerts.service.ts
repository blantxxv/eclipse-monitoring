import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { sendTelegramMessage, escapeHtml } from '../common/telegram.util';

const EVAL_INTERVAL_MS = 60 * 1000;
const COOLDOWN_MINUTES = 30;
// Сервер должен молчать не меньше этого времени, прежде чем шлём алерт «недоступен» — гасит краткие
// флапы (перезапуск агента, обновление, кратковременная сеть). Статус в UI всё равно становится offline на 120с.
const OFFLINE_ALERT_MS = 3 * 60 * 1000;
// После старта самой панели не шлём offline-алерты первые несколько минут: при редеплое бэкенда метрики
// временно не принимаются, last_seen у всех устаревает — без этого grace посыпались бы ложные «сервер недоступен».
const BOOT_GRACE_MS = 3 * 60 * 1000;

type Level = 'warning' | 'critical' | 'info';

@Injectable()
export class AlertsService implements OnModuleInit {
  private readonly startedAt = Date.now();
  constructor(private readonly db: DbService, private readonly settings: SettingsService) {}

  onModuleInit() {
    setInterval(() => { this.evaluate().catch((e) => console.error('alert evaluation error:', e)); }, EVAL_INTERVAL_MS);
  }

  async recent(limit = 10, offset = 0) {
    const lim = Math.min(100, Math.max(1, limit));
    const off = Math.max(0, offset);
    const r = await this.db.query('select id,server_id,server_name,kind,level,message,created_at from alert_log order by created_at desc limit $1 offset $2', [lim + 1, off]);
    const hasMore = r.rows.length > lim;
    return { items: r.rows.slice(0, lim), hasMore };
  }

  async evaluate() {
    const cfg = await this.settings.getInternal();
    const bootGraceOver = Date.now() - this.startedAt >= BOOT_GRACE_MS;
    const servers = await this.db.query(`select id,name,ip,status,category,last_seen_at from servers where status <> 'waiting' and status <> 'revoked'`);
    for (const s of servers.rows) {
      if (s.status === 'offline') {
        const silentMs = s.last_seen_at ? Date.now() - new Date(s.last_seen_at).getTime() : Infinity;
        // Алертим, только если сервер молчит ≥ OFFLINE_ALERT_MS и панель уже пережила стартовый grace.
        if (bootGraceOver && silentMs >= OFFLINE_ALERT_MS) {
          await this.transition(s.id, s.name, s.ip, 'offline', true, `Сервер недоступен — метрики не поступают более ${Math.max(2, Math.floor(silentMs / 60000))} мин.`, 'critical', cfg);
        }
        continue;
      }
      await this.transition(s.id, s.name, s.ip, 'offline', false, '', 'critical', cfg);
      if (s.status === 'paused') continue;

      // Все пороговые метрики (CPU/RAM/диск/трафик) оцениваются по СРЕДНЕМУ за окно «Длительность»
      // (cfg.sustainedMinutes) — уведомление приходит, только если показатель держится выше порога
      // дольше указанного времени. Это ровно то, что обещает подпись в настройках.
      const window = await this.db.query(
        `select avg(cpu_usage_percent)::float cpu, avg(memory_usage_percent)::float ram, avg(disk_usage_percent)::float disk,
                avg(inbound_bps)::float inb, avg(outbound_bps)::float outb, min(timestamp) earliest, count(*)::int n
         from server_metrics where server_id=$1 and timestamp > now() - ($2 || ' minutes')::interval`,
        [s.id, cfg.sustainedMinutes],
      );
      const w = window.rows[0];
      const covered = w?.earliest && (Date.now() - new Date(w.earliest).getTime()) >= cfg.sustainedMinutes * 60 * 1000 * 0.75;

      if (covered && w.n >= 2) {
        await this.transition(s.id, s.name, s.ip, 'cpu', w.cpu >= cfg.cpuPercent, `Высокая нагрузка CPU: ${w.cpu.toFixed(1)}% в среднем за последние ${cfg.sustainedMinutes} мин. (порог ${cfg.cpuPercent}%).`, 'warning', cfg, `CPU в норме: ${w.cpu.toFixed(1)}%.`);
        await this.transition(s.id, s.name, s.ip, 'ram', w.ram >= cfg.ramPercent, `Высокая нагрузка RAM: ${w.ram.toFixed(1)}% в среднем за последние ${cfg.sustainedMinutes} мин. (порог ${cfg.ramPercent}%).`, 'warning', cfg, `RAM в норме: ${w.ram.toFixed(1)}%.`);
        if (w.disk !== null && w.disk !== undefined) {
          await this.transition(s.id, s.name, s.ip, 'disk', w.disk >= cfg.diskPercent, `Диск почти заполнен: ${w.disk.toFixed(1)}% (в среднем за ${cfg.sustainedMinutes} мин, порог ${cfg.diskPercent}%).`, 'critical', cfg, `Диск в норме: ${w.disk.toFixed(1)}%.`);
        }
        // Трафик-алерты не нужны для мостов и WiFi (там всплески — норма).
        if (s.category !== 'bridge' && s.category !== 'wifi') {
          // inbound_bps / outbound_bps хранятся в БАЙТАХ/с; порог задан в Мбит/с — сравниваем в битах.
          // Берём МАКСИМУМ из направлений, а не сумму: линк full-duplex, у каждого направления
          // своя ёмкость, и шейпер (CAKE) тоже режет по одному направлению. Сумма для прокси-ноды
          // всегда ~вдвое больше реальной скорости (HAProxy каждый байт принимает и тут же отдаёт),
          // из-за чего порог 700 срабатывал уже на 350 Мбит/с в каждую сторону.
          const avgBytes = Math.max(Number(w.inb || 0), Number(w.outb || 0));
          const avgMbps = (avgBytes * 8) / 1_000_000;
          await this.transition(s.id, s.name, s.ip, 'traffic', avgMbps >= cfg.trafficMbps, `Аномальный трафик: ${this.fmtMbps(avgBytes)} в среднем за ${cfg.sustainedMinutes} мин (порог ${cfg.trafficMbps} Мбит/с).`, 'warning', cfg, `Трафик вернулся к норме: ${this.fmtMbps(avgBytes)}.`);
        }
      }

      const latest = await this.db.query(`select bridges from server_metrics where server_id=$1 order by timestamp desc limit 1`, [s.id]);
      const l = latest.rows[0];

      // HAProxy-мосты. Правило (чтобы не спамить уведомлениями):
      //   • < порога down (cfg.bridgeDownMinutes, по умолч. 5 мин) — молчим (это флап);
      //   • достиг порога down       — шлём ОДИН алерт (без повторов каждые 30 мин);
      //   • ≥ 60 мин down            — считаем мост нерабочим и ОТКЛЮЧАЕМ мониторинг по нему
      //                                (disabled=true): тихо закрываем инцидент, больше ничего не шлём;
      //   • восстановление (UP)      — один раз «снова доступен» и снимаем disabled.
      // Мониторинг мостов выключен в настройках — гасим всё, что связано с мостами, и не трогаем их.
      if (!cfg.bridgeMonitoring) {
        await this.db.query(`delete from bridge_state where server_id=$1`, [s.id]);
        await this.db.query(`update alert_state set active=false where server_id=$1 and kind like 'bridge_%'`, [s.id]);
        await this.db.query(`update incidents set status='resolved',resolved_at=now(),duration_seconds=extract(epoch from (now()-started_at))::int where server_id=$1 and status='open' and kind like 'bridge_%'`, [s.id]);
        continue;
      }
      const bridges = Array.isArray(l?.bridges) ? l.bridges.slice(0, 60) : [];
      const seen: string[] = [];
      for (const b of bridges) {
        const bname = `${b.backend || '?'}/${b.name || '?'}`;
        seen.push(bname);
        const addr = b.addr ? ` [${b.addr}]` : '';
        const status = String(b.status || '').toUpperCase();
        const kind = `bridge_down:${bname}`;
        if (status.includes('MAINT') || status.includes('DRAIN')) { await this.db.query(`delete from bridge_state where server_id=$1 and bridge=$2`, [s.id, bname]); await this.silentResolve(s.id, kind); continue; }
        const down = status.startsWith('DOWN');
        const t = await this.trackBridge(s.id, bname, down ? 'DOWN' : 'UP');
        if (!down) {
          if (t.disabled) {
            // мост был down > 1 ч (мониторинг отключён) и теперь снова поднялся — сообщаем один раз и включаем мониторинг обратно.
            await this.log(s.id, s.name, kind, 'info', `${s.name} (${s.ip}): Мост ${bname}${addr} снова доступен — мониторинг возобновлён.`);
            await this.notify(cfg, `✅ <b>${escapeHtml(s.name)}</b> (${s.ip})\nМост ${escapeHtml(bname)}${addr} снова доступен — мониторинг возобновлён.`);
            await this.db.query(`update bridge_state set disabled=false where server_id=$1 and bridge=$2`, [s.id, bname]);
            await this.db.query(`update alert_state set active=false where server_id=$1 and kind=$2`, [s.id, kind]);
          } else {
            await this.transition(s.id, s.name, s.ip, kind, false, '', 'critical', cfg, `Мост ${bname}${addr} снова доступен.`);
          }
        } else if (t.downMin >= 60) {
          // нерабочий > 1 ч — отключаем мониторинг: помечаем disabled, тихо закрываем инцидент, дальше молчим.
          if (!t.disabled) {
            await this.db.query(`update bridge_state set disabled=true where server_id=$1 and bridge=$2`, [s.id, bname]);
            await this.silentResolve(s.id, kind);
            await this.log(s.id, s.name, kind, 'info', `${s.name} (${s.ip}): Мост ${bname}${addr} недоступен более часа — мониторинг по нему отключён до восстановления.`);
          }
        } else if (t.downMin >= cfg.bridgeDownMinutes) {
          // один алерт на инцидент (renotify=false — не долбим каждые 30 мин). Порог настраивается.
          await this.transition(s.id, s.name, s.ip, kind, true, `Мост ${bname}${addr} недоступен уже ${Math.floor(t.downMin)} мин (статус HAProxy: ${status || '?'}).`, 'critical', cfg, `Мост ${bname}${addr} снова доступен.`, false);
        }
        const sessions = Number(b.sessions || 0);
        // Нагрузку не проверяем у нерабочих (disabled) мостов.
        await this.transition(s.id, s.name, s.ip, `bridge_load:${bname}`, !down && !t.disabled && sessions >= cfg.bridgeSessions, `Мост ${bname}${addr} перегружен: ${sessions} сессий (порог ${cfg.bridgeSessions}).`, 'warning', cfg, `Нагрузка на мост ${bname}${addr} в норме: ${sessions} сессий.`, false);
      }
      // Мосты, которые исчезли (haproxy выключили/убрали backend): чистим состояние и закрываем их инциденты.
      const activeKinds: string[] = [];
      for (const bn of seen) { activeKinds.push(`bridge_down:${bn}`, `bridge_load:${bn}`); }
      await this.db.query(`delete from bridge_state where server_id=$1 and not (bridge = any($2::text[]))`, [s.id, seen]);
      await this.db.query(`update alert_state set active=false where server_id=$1 and kind like 'bridge_%' and not (kind = any($2::text[]))`, [s.id, activeKinds]);
      await this.db.query(`update incidents set status='resolved',resolved_at=now(),duration_seconds=extract(epoch from (now()-started_at))::int where server_id=$1 and status='open' and kind like 'bridge_%' and not (kind = any($2::text[]))`, [s.id, activeKinds]);
    }
  }

  // Закрыть инцидент и снять активность алерта без отправки уведомления (для «нерабочих» мостов).
  private async silentResolve(serverId: string, kind: string) {
    await this.db.query(`update alert_state set active=false where server_id=$1 and kind=$2`, [serverId, kind]);
    await this.db.query(`update incidents set status='resolved',resolved_at=now(),duration_seconds=extract(epoch from (now()-started_at))::int where server_id=$1 and kind=$2 and status='open'`, [serverId, kind]);
  }

  // Состояние моста: downMin — сколько минут непрерывно DOWN (0 если UP или статус только что сменился),
  // disabled — был ли мониторинг по нему отключён (лежал > 1 ч). disabled сохраняется при смене статуса,
  // чтобы при восстановлении (DOWN→UP) вызывающий код мог один раз сообщить «мониторинг возобновлён».
  private async trackBridge(serverId: string, bridge: string, cur: string): Promise<{ downMin: number; disabled: boolean }> {
    const r = await this.db.query('select status,since,disabled from bridge_state where server_id=$1 and bridge=$2', [serverId, bridge]);
    const prev = r.rows[0];
    const disabled = Boolean(prev?.disabled);
    if (!prev || prev.status !== cur) {
      await this.db.query(`insert into bridge_state(server_id,bridge,status,since,disabled) values($1,$2,$3,now(),false) on conflict (server_id,bridge) do update set status=$3,since=now()`, [serverId, bridge, cur]);
      return { downMin: 0, disabled };
    }
    if (cur !== 'DOWN') return { downMin: 0, disabled };
    return { downMin: (Date.now() - new Date(prev.since).getTime()) / 60000, disabled };
  }

  private async transition(serverId: string, name: string, ip: string, kind: string, triggered: boolean, message: string, level: Level, cfg: Awaited<ReturnType<SettingsService['getInternal']>>, resolvedMessage?: string, renotify = true) {
    const r = await this.db.query('select active,last_notified_at from alert_state where server_id=$1 and kind=$2', [serverId, kind]);
    const state = r.rows[0];
    const wasActive = Boolean(state?.active);
    const tgOn = Boolean(cfg.botToken && cfg.chatIds.length);

    if (triggered) {
      // renotify=false — уведомляем только на переходе «в норме → проблема», без повторов каждые 30 мин.
      const dueForRenotify = renotify && (!state?.last_notified_at || (Date.now() - new Date(state.last_notified_at).getTime()) >= COOLDOWN_MINUTES * 60 * 1000);
      if (!wasActive || dueForRenotify) {
        await this.log(serverId, name, kind, level, `${name} (${ip}): ${message}`);
        await this.notify(cfg, `⚠️ <b>${escapeHtml(name)}</b> (${ip})\n${escapeHtml(message)}`);
        await this.db.query(`insert into alert_state(server_id,kind,active,since,last_notified_at) values($1,$2,true,coalesce((select since from alert_state where server_id=$1 and kind=$2),now()),now()) on conflict (server_id,kind) do update set active=true,last_notified_at=now(),since=coalesce(alert_state.since,now())`, [serverId, kind]);
        // Open a grouped incident if one is not already open for this server+kind.
        await this.db.query(`insert into incidents(server_id,server_name,kind,level,message,telegram_notified,status) select $1,$2,$3,$4,$5,$6,'open' where not exists (select 1 from incidents where server_id=$1 and kind=$3 and status='open')`, [serverId, name, kind, level, message, tgOn]);
        if (tgOn) await this.db.query(`update incidents set telegram_notified=true where server_id=$1 and kind=$2 and status='open'`, [serverId, kind]);
      }
      return;
    }

    if (wasActive) {
      const msg = resolvedMessage || 'Показатель вернулся в норму.';
      await this.log(serverId, name, kind, 'info', `${name} (${ip}): ${msg}`);
      await this.notify(cfg, `✅ <b>${escapeHtml(name)}</b> (${ip})\n${escapeHtml(msg)}`);
      await this.db.query(`update alert_state set active=false where server_id=$1 and kind=$2`, [serverId, kind]);
      // Close the matching open incident.
      await this.db.query(`update incidents set status='resolved',resolved_at=now(),duration_seconds=extract(epoch from (now()-started_at))::int where server_id=$1 and kind=$2 and status='open'`, [serverId, kind]);
    }
  }

  private async log(serverId: string, name: string, kind: string, level: Level, message: string) {
    await this.db.query('insert into alert_log(server_id,server_name,kind,level,message) values($1,$2,$3,$4,$5)', [serverId, name, kind, level, message]);
  }

  private async notify(cfg: Awaited<ReturnType<SettingsService['getInternal']>>, text: string) {
    if (!cfg.botToken || !cfg.chatIds.length) return;
    await sendTelegramMessage(cfg.botToken, cfg.chatIds, text);
  }

  private fmtBps(v: number) {
    const units = ['Б', 'КБ', 'МБ', 'ГБ']; let n = v, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}/с`;
  }

  // bytes/s -> Mbit/s (or Gbit/s), to match the traffic threshold unit.
  private fmtMbps(bytesPerSec: number) {
    const mbps = (bytesPerSec * 8) / 1_000_000;
    if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Гбит/с`;
    return `${mbps.toFixed(mbps >= 100 ? 0 : 1)} Мбит/с`;
  }
}
