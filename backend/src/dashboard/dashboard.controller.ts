import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DbService } from '../db/db.service';
import { AGENT_LATEST_VERSION, BACKEND_VERSION, FRONTEND_VERSION, BUILD_HASH, BUILD_TIME, isAgentOutdated } from '../common/version';

const REFRESH_STATUS_SQL = `update servers set status=case when status='revoked' then 'revoked' when last_seen_at is null then 'waiting' when last_seen_at < now() - interval '120 seconds' then 'offline' when status='paused' then 'paused' when last_seen_at < now() - interval '30 seconds' then 'warning' else 'online' end`;

@Controller('api/dashboard') @UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly db: DbService) {}
  @Get('summary') async summary(@Query('alertsSince') alertsSince?: string) {
    await this.db.query(REFRESH_STATUS_SQL);
    const status = await this.db.query(`select count(*)::int total,count(*) filter(where status='online')::int online,count(*) filter(where status='waiting')::int waiting,count(*) filter(where status='warning')::int warning,count(*) filter(where status='offline')::int offline,count(*) filter(where status='paused')::int paused,count(*) filter(where status='revoked')::int revoked from servers`);
    const metrics = await this.db.query(`select avg(m.cpu_usage_percent)::float average_cpu,avg(m.memory_usage_percent)::float average_ram,avg((coalesce(m.cpu_usage_percent,0)+coalesce(m.memory_usage_percent,0))/2)::float average_load,avg(m.health_score)::float average_health,coalesce(sum(m.inbound_bps),0)::float total_inbound_bps,coalesce(sum(m.outbound_bps),0)::float total_outbound_bps,coalesce(sum(m.total_connections),0)::bigint total_connections,coalesce(sum(m.memory_total_bytes),0)::float total_ram_bytes from servers s join lateral (select * from server_metrics sm where sm.server_id=s.id order by sm.timestamp desc limit 1) m on true where s.status in ('online','warning')`);
    const transferred = await this.db.query(`select coalesce(sum(x.rx_total_bytes+x.tx_total_bytes),0)::float total_transferred_bytes from (select distinct on (server_id,interface) rx_total_bytes,tx_total_bytes from network_metrics where interface<>'lo' and interface not like 'ifb%' and interface not like 'docker%' and interface not like 'veth%' and interface not like 'br-%' and interface not like 'virbr%' order by server_id,interface,timestamp desc) x`);
    const recentAlerts = await this.db.query(`select count(*)::int from alert_log where created_at > now() - interval '24 hours'`);
    const openIncidents = await this.db.query(`select count(*)::int from incidents where status='open'`);
    let alertsUnread = recentAlerts.rows[0].count;
    if (alertsSince) { const since = new Date(alertsSince); if (!Number.isNaN(since.getTime())) { const u = await this.db.query(`select count(*)::int from alert_log where created_at > $1`, [since]); alertsUnread = u.rows[0].count; } }
    return { ...status.rows[0], ...metrics.rows[0], ...transferred.rows[0], alerts_24h: recentAlerts.rows[0].count, alerts_unread: alertsUnread, open_incidents: openIncidents.rows[0].count };
  }

  @Get('problems') async problems() {
    await this.db.query(REFRESH_STATUS_SQL);
    const offline = (await this.db.query(`select id,name,ip,last_seen_at from servers where status='offline' order by last_seen_at asc nulls first`)).rows;
    const agentStale = (await this.db.query(`select id,name,extract(epoch from (now()-last_seen_at))::int seconds from servers where status in ('online','warning') and last_seen_at < now() - interval '60 seconds' order by last_seen_at asc`)).rows;
    const highLoad = (await this.db.query(`select a.server_id id,s.name,a.kind,a.since from alert_state a join servers s on s.id=a.server_id where a.active=true and a.kind in ('cpu','ram','disk','traffic') order by a.since asc`)).rows;
    const vpnFlag = (await this.db.query(`select value from settings where key='vpn_monitoring'`)).rows[0];
    const vpnMonitoring = !(vpnFlag && vpnFlag.value === 'false');
    const vpnDown = vpnMonitoring ? (await this.db.query(`select s.id,s.name,m.vpn_service from servers s join lateral (select vpn_active,vpn_service from server_metrics sm where sm.server_id=s.id order by timestamp desc limit 1) m on true where s.status in ('online','warning') and m.vpn_active=false order by s.name`)).rows : [];
    const bridgeFlag = (await this.db.query(`select value from settings where key='bridge_monitoring'`)).rows[0];
    const bridgeMonitoring = !(bridgeFlag && bridgeFlag.value === 'false');
    const bridgesDown = bridgeMonitoring ? (await this.db.query(`select s.id,s.name,b->>'backend' backend,b->>'name' bridge,b->>'addr' addr,b->>'status' status from servers s join lateral (select bridges from server_metrics sm where sm.server_id=s.id order by timestamp desc limit 1) m on true cross join lateral jsonb_array_elements(coalesce(m.bridges,'[]'::jsonb)) b where s.status in ('online','warning') and upper(b->>'status') like 'DOWN%' order by s.name`)).rows : [];
    const enrolled = (await this.db.query(`select id,name,agent_version,status from servers where status in ('online','warning','paused','offline') order by name`)).rows;
    const outdatedAgents = enrolled.filter((s) => isAgentOutdated(s.agent_version)).map((s) => ({ id: s.id, name: s.name, agent_version: s.agent_version || null, status: s.status }));
    // Дубликаты по IP (две записи на одну машину) — источник ложных offline; ловим, если проскочили мимо запрета.
    const duplicateIps = (await this.db.query(`select ip, count(*)::int cnt, string_agg(name, ' | ' order by created_at) names from servers where status<>'revoked' group by ip having count(*)>1 order by ip`)).rows;

    const settings = (await this.db.query(`select key,value from settings where key in ('telegram_bot_token_enc','telegram_chat_ids')`)).rows;
    const smap: Record<string, string> = {}; for (const r of settings) smap[r.key] = r.value;
    let chatIds: string[] = []; try { chatIds = smap.telegram_chat_ids ? JSON.parse(smap.telegram_chat_ids) : []; } catch { chatIds = []; }
    const telegram: { level: string; message: string }[] = [];
    if (!smap.telegram_bot_token_enc) telegram.push({ level: 'warning', message: 'Telegram-бот не настроен — уведомления не приходят.' });
    else if (!chatIds.length) telegram.push({ level: 'warning', message: 'Telegram-бот настроен, но не добавлен ни один получатель.' });

    const total = offline.length + agentStale.length + highLoad.length + vpnDown.length + bridgesDown.length + outdatedAgents.length + duplicateIps.length + telegram.length;
    return { offline, agentStale, highLoad, vpnDown, bridgesDown, outdatedAgents, duplicateIps, telegram, total };
  }

  @Get('versions') async versions() {
    await this.db.query(REFRESH_STATUS_SQL);
    const rows = (await this.db.query(`select id,name,agent_version,status,last_seen_at from servers where status in ('online','warning','paused','offline') order by name`)).rows;
    const agents = rows.map((s) => ({ id: s.id, name: s.name, agent_version: s.agent_version || null, status: s.status, outdated: isAgentOutdated(s.agent_version), unknown: !s.agent_version }));
    const counts = {
      total: agents.length,
      upToDate: agents.filter((a) => a.agent_version && !a.outdated).length,
      outdated: agents.filter((a) => a.agent_version && a.outdated).length,
      unknown: agents.filter((a) => !a.agent_version).length,
    };
    return { backend: BACKEND_VERSION, frontend: FRONTEND_VERSION, agentLatest: AGENT_LATEST_VERSION, buildHash: BUILD_HASH, buildTime: BUILD_TIME, counts, agents };
  }

  // История трафика по всему флоту: суммируем почасовые агрегаты по всем нодам.
  // Отдельный лёгкий запрос — рисуем на вкладке «Ноды» график «Трафик флота».
  @Get('fleet-history') async fleetHistory(@Query('range') range?: string) {
    const RANGES: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
    const iv = RANGES[String(range || '24h')] || '24 hours';
    const r = await this.db.query(
      `select bucket as timestamp,
              coalesce(sum(avg_inbound_bps),0)::float inbound_bps,
              coalesce(sum(avg_outbound_bps),0)::float outbound_bps,
              coalesce(sum(max_connections),0)::float total_connections
       from metrics_rollup
       where bucket > now() - ($1)::interval
       group by bucket
       order by bucket asc
       limit 800`,
      [iv],
    );
    return r.rows;
  }

  @Get('incidents') async incidents(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('status') status?: string) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 20));
    const off = Math.max(0, Number(offset) || 0);
    const filter = status === 'open' ? `where status='open'` : status === 'resolved' ? `where status='resolved'` : '';
    const r = await this.db.query(`select id,server_id,server_name,kind,level,message,started_at,resolved_at,duration_seconds,telegram_notified,status from incidents ${filter} order by started_at desc limit $1 offset $2`, [lim + 1, off]);
    const hasMore = r.rows.length > lim;
    return { items: r.rows.slice(0, lim), hasMore };
  }
}
