import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DbService } from '../db/db.service';
import { decrypt, encrypt, sha256 } from '../common/crypto.util';

export interface CreateServerInput { name: string; ip: string; port?: number; description?: string; tags?: string[]; category?: string; country?: string | null; }

const LIVE_STATUSES = new Set(['online', 'warning', 'paused']);
const VALID_COMMANDS = new Set(['start', 'stop', 'restart', 'delete', 'update', 'check-config', 'logs', 'bridge-check', 'poweroff']);
const VALID_CATEGORIES = new Set(['bs', 'wifi', 'bridge', 'other']);
const normCategory = (c?: string) => (c && VALID_CATEGORIES.has(c) ? c : 'other');
// Страна — двухбуквенный ISO-код в нижнем регистре; всё остальное считаем «страна не указана».
const normCountry = (c?: string | null) => {
  const v = String(c ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(v) ? v : null;
};

// Реальный трафик считаем только по физическим интерфейсам (реальному внешнему NIC).
// Виртуальные и туннельные интерфейсы несут КОПИЮ того же потока, что уже прошёл через
// физический NIC, и суммирование их завышает скорость в разы:
//   - ifb        — ingress-shaping зеркалит входящий трафик (завышение x2)
//   - wg/tun/tap  — VPN-туннель (WireGuard/OpenVPN): тот же трафик, что и на eth0, но в plaintext
//   - veth/docker/br-/virbr — контейнерные мосты
// Считаем только реальный аплинк (eth0/ens/enp/…), где и виден настоящий внешний трафик.
function isPhysicalIface(name: any): boolean {
  const n = String(name || '');
  if (!n || n === 'lo') return false;
  return !/^(ifb|docker|veth|br-|virbr|dummy|cni|flannel|cali|kube|nerdctl|tailscale|zt|wg|tun|tap|sit|gre|gretap|ip6tnl|ip6gre|ppp|tunl|teql|nlmon|nordlynx|proton|utun)/i.test(n);
}
function bridgeAddrHost(addr: any): string {
  const a = String(addr || '');
  if (!a) return '';
  return (a.includes(':') ? a.slice(0, a.lastIndexOf(':')) : a).replace(/[\[\]]/g, '');
}
function isLoopbackAddr(addr: any): boolean {
  const h = bridgeAddrHost(addr);
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h.startsWith('127.');
}

@Injectable()
export class ServersService {
  private vpnMonitoring = true;
  constructor(private readonly db: DbService) {}
  private async loadFlags() {
    try { const r = await this.db.query(`select value from settings where key='vpn_monitoring'`); this.vpnMonitoring = !(r.rows[0] && r.rows[0].value === 'false'); }
    catch { this.vpnMonitoring = true; }
  }
  // Запрет дубликатов по IP: одна физическая нода = одна запись. Повторное добавление того же IP —
  // почти всегда ошибка (как было с ms1: старая запись осиротела и слала ложные offline). При переустановке
  // агента нужно переиздать команду у СУЩЕСТВУЮЩЕЙ ноды, а не заводить новую.
  private async assertIpAvailable(ip: string, exceptId?: string) {
    const params: any[] = [ip];
    let q = `select name from servers where ip=$1 and status<>'revoked'`;
    if (exceptId) { q += ` and id<>$2`; params.push(exceptId); }
    const r = await this.db.query(q + ' limit 1', params);
    if (r.rows[0]) throw new BadRequestException(`Нода с IP ${ip} уже есть в панели: «${r.rows[0].name}». Дубликаты по IP запрещены. Если это переустановка агента — переиздайте команду у существующей ноды («Сгенерировать команду агента»), а не создавайте новую.`);
  }
  async create(input: CreateServerInput) {
    if (!input.name || input.name.trim().length < 2) throw new BadRequestException('server name is required');
    if (!input.ip || input.ip.trim().length < 3) throw new BadRequestException('server ip is required');
    await this.assertIpAvailable(input.ip.trim());
    const token = randomBytes(24).toString('hex');
    const tokenHash = sha256(token);
    const ttl = Number(process.env.ENROLLMENT_TOKEN_TTL_MINUTES || 15);
    const result = await this.db.query(`insert into servers(name,ip,port,description,tags,category,country,status,enrollment_token_hash,enrollment_expires_at) values($1,$2,$3,$4,$5,$6,$7,'waiting',$8,now()+($9||' minutes')::interval) returning id,name,ip,port,description,tags,category,country,status,last_seen_at,created_at`, [input.name.trim(), input.ip.trim(), Number(input.port || 3406), input.description || null, input.tags || [], normCategory(input.category), normCountry(input.country), tokenHash, ttl]);
    const s = result.rows[0];
    return { ...this.publicServer(s), enrollment_token: token, install_command: this.installCommand(s.id, token) };
  }
  async setCategory(id: string, category: string) {
    const r = await this.db.query(`update servers set category=$2,updated_at=now() where id=$1 returning id`, [id, normCategory(category)]);
    if (!r.rows[0]) throw new NotFoundException('server not found');
    return { ok: true, category: normCategory(category) };
  }
  // Редактирование ноды (переименование и т.п.). Патчим только переданные поля; агент авторизуется
  // по секрету, поэтому смена ip/port — это просто отображаемые данные для управления, безопасно.
  async update(id: string, input: { name?: string; description?: string; ip?: string; port?: number; category?: string; country?: string | null; tags?: string[] }) {
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (input.name !== undefined) { const n = String(input.name).trim(); if (n.length < 2) throw new BadRequestException('server name is required'); sets.push(`name=$${i++}`); vals.push(n); }
    if (input.description !== undefined) { sets.push(`description=$${i++}`); vals.push(input.description ? String(input.description).slice(0, 500) : null); }
    if (input.ip !== undefined) { const ip = String(input.ip).trim(); if (ip.length < 3) throw new BadRequestException('server ip is required'); await this.assertIpAvailable(ip, id); sets.push(`ip=$${i++}`); vals.push(ip); }
    if (input.port !== undefined) { sets.push(`port=$${i++}`); vals.push(Number(input.port) || 3406); }
    if (input.category !== undefined) { sets.push(`category=$${i++}`); vals.push(normCategory(input.category)); }
    if (input.country !== undefined) { sets.push(`country=$${i++}`); vals.push(normCountry(input.country)); }
    if (input.tags !== undefined) { sets.push(`tags=$${i++}`); vals.push(Array.isArray(input.tags) ? input.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : []); }
    if (!sets.length) throw new BadRequestException('nothing to update');
    sets.push('updated_at=now()'); vals.push(id);
    const r = await this.db.query(`update servers set ${sets.join(',')} where id=$${i}`, vals);
    if (!r.rowCount) throw new NotFoundException('server not found');
    return this.get(id);
  }
  // nulls first: у новых нод position ещё null — они всплывают наверх (новейшие сверху по created_at),
  // а вручную упорядоченные (drag-and-drop проставил position) идут ниже в своём порядке.
  async list() { await this.loadFlags(); await this.refreshStatuses(); const r = await this.db.query(this.listSql() + ' order by s.position asc nulls first, s.created_at desc'); return r.rows.map(x => this.publicServer(x)); }
  async reorder(ids: string[]) {
    if (!Array.isArray(ids)) throw new BadRequestException('ids array required');
    let pos = 0;
    for (const id of ids) { await this.db.query('update servers set position=$2 where id=$1', [id, pos]); pos += 1; }
    return { ok: true };
  }
  async poweroffByCategories(categories: string[]) {
    const cats = (Array.isArray(categories) ? categories : []).filter((c) => VALID_CATEGORIES.has(c));
    if (!cats.length) throw new BadRequestException('categories required');
    const r = await this.db.query(`select id,name from servers where category = any($1::text[]) and status in ('online','warning','paused')`, [cats]);
    for (const s of r.rows) await this.queueCommand(s.id, 'poweroff');
    return { ok: true, count: r.rows.length, servers: r.rows.map((x: any) => x.name) };
  }
  async get(id: string) { await this.loadFlags(); await this.refreshStatuses(); const r = await this.db.query(this.listSql() + ' where s.id=$1', [id]); if (!r.rows[0]) throw new NotFoundException('server not found'); return this.publicServer(r.rows[0]); }
  async getInternal(id: string) { const r = await this.db.query('select * from servers where id=$1', [id]); return r.rows[0]; }
  async regenerateToken(id: string) { const token = randomBytes(24).toString('hex'); const r = await this.db.query(`update servers set enrollment_token_hash=$2,enrollment_expires_at=now()+($3||' minutes')::interval,updated_at=now(),status='waiting' where id=$1 returning id,name,ip,port,description,tags,status,last_seen_at,created_at`, [id, sha256(token), Number(process.env.ENROLLMENT_TOKEN_TTL_MINUTES || 15)]); if (!r.rows[0]) throw new NotFoundException('server not found'); return { ...this.publicServer(r.rows[0]), enrollment_token: token, install_command: this.installCommand(id, token) }; }
  async revoke(id: string) { const r = await this.db.query(`update servers set agent_secret_enc=null,status='revoked',updated_at=now() where id=$1 returning *`, [id]); if (!r.rows[0]) throw new NotFoundException('server not found'); return this.publicServer(r.rows[0]); }
  async delete(id: string) { await this.db.query('delete from servers where id=$1', [id]); return { ok: true }; }
  async registerAgent(serverId: string, token: string, agentSecret: string) { const s = await this.getInternal(serverId); if (!s) throw new BadRequestException('unknown server'); if (!s.enrollment_token_hash || !s.enrollment_expires_at) throw new BadRequestException('server has no active enrollment token'); if (new Date(s.enrollment_expires_at).getTime() < Date.now()) throw new BadRequestException('enrollment token expired'); if (sha256(token || '') !== s.enrollment_token_hash) throw new BadRequestException('invalid enrollment token'); await this.db.query(`update servers set agent_secret_enc=$2,enrollment_token_hash=null,enrollment_expires_at=null,status='online',last_seen_at=now(),updated_at=now() where id=$1`, [serverId, encrypt(agentSecret)]); }
  async getAgentSecret(id: string) { const s = await this.getInternal(id); return s?.agent_secret_enc ? decrypt(s.agent_secret_enc) : null; }
  async storeMetrics(id: string, p: any, meta: { latencyMs?: number } = {}) {
    const agentVersion = p?.agent_version ? String(p.agent_version).slice(0, 32) : null;
    if (p && p.heartbeat) { await this.db.query(`update servers set status='paused',agent_version=coalesce($2,agent_version),last_seen_at=now(),updated_at=now() where id=$1`, [id, agentVersion]); return; }
    const cpu = p.cpu || {}, mem = p.memory || {}, disk = p.disk?.root || p.disk || {}, net = Array.isArray(p.network) ? p.network : [], con = Array.isArray(p.connections) ? p.connections : [];
    const physNet = net.filter((n: any) => isPhysicalIface(n.interface));
    const inbound = physNet.reduce((a: number, n: any) => a + Number(n.rx_bytes_per_sec || 0), 0); const outbound = physNet.reduce((a: number, n: any) => a + Number(n.tx_bytes_per_sec || 0), 0); const totalCon = con.reduce((a: number, c: any) => a + Number(c.established || 0), 0);
    const vpn = p.vpn && typeof p.vpn === 'object' ? p.vpn : null;
    const vpnActive = vpn ? Boolean(vpn.active) : null; const vpnService = vpn && vpn.service ? String(vpn.service).slice(0, 64) : null;
    const health = this.computeHealthScore({
      cpu_usage_percent: cpu.usage_percent ?? p.cpu_usage,
      memory_usage_percent: mem.usage_percent ?? p.memory_usage,
      disk_usage_percent: disk.usage_percent ?? p.disk_usage,
      net_err_per_sec: p.net_err_per_sec, net_drop_per_sec: p.net_drop_per_sec,
      ping_ms: p.ping_ms, vpn_active: vpnActive, uptime_seconds: p.uptime_seconds,
    });
    const topCpu = Array.isArray(p.top_cpu) ? JSON.stringify(p.top_cpu.slice(0, 10)) : null;
    const topMem = Array.isArray(p.top_mem) ? JSON.stringify(p.top_mem.slice(0, 10)) : null;
    const bridgeList = Array.isArray(p.bridges) ? p.bridges.filter((b: any) => !isLoopbackAddr(b?.addr)).slice(0, 100) : [];
    const bridges = bridgeList.length ? JSON.stringify(bridgeList) : null;
    await this.db.query(`insert into server_metrics(server_id,hostname,public_ip,local_ip,os,kernel,uptime_seconds,cpu_model,cpu_cores,cpu_threads,cpu_usage_percent,load_1,load_5,load_15,memory_total_bytes,memory_used_bytes,memory_free_bytes,memory_usage_percent,swap_total_bytes,swap_used_bytes,swap_usage_percent,disk_total_bytes,disk_used_bytes,disk_free_bytes,disk_usage_percent,inbound_bps,outbound_bps,total_connections,agent_version,agent_latency_ms,net_err_per_sec,net_drop_per_sec,ping_ms,vpn_active,vpn_service,top_cpu,top_mem,health_score,bridges,raw) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40)`, [id, p.hostname || null, p.public_ip || null, p.local_ip || null, p.os || null, p.kernel || null, this.num(p.uptime_seconds), cpu.model || null, this.num(cpu.cores), this.num(cpu.threads), this.num(cpu.usage_percent ?? p.cpu_usage), this.num(cpu.load_1), this.num(cpu.load_5), this.num(cpu.load_15), this.num(mem.total_bytes), this.num(mem.used_bytes), this.num(mem.free_bytes), this.num(mem.usage_percent ?? p.memory_usage), this.num(mem.swap_total_bytes), this.num(mem.swap_used_bytes), this.num(mem.swap_usage_percent), this.num(disk.total_bytes), this.num(disk.used_bytes), this.num(disk.free_bytes), this.num(disk.usage_percent ?? p.disk_usage), inbound, outbound, totalCon || this.num(p.connections) || 0, agentVersion, this.num(meta.latencyMs), this.num(p.net_err_per_sec) || 0, this.num(p.net_drop_per_sec) || 0, this.num(p.ping_ms), vpnActive, vpnService, topCpu, topMem, health, bridges, JSON.stringify(p)]);
    for (const n of net) await this.db.query(`insert into network_metrics(server_id,interface,rx_bytes_per_sec,tx_bytes_per_sec,rx_total_bytes,tx_total_bytes,status,ip) values($1,$2,$3,$4,$5,$6,$7,$8)`, [id, String(n.interface || 'unknown'), this.num(n.rx_bytes_per_sec) || 0, this.num(n.tx_bytes_per_sec) || 0, this.num(n.rx_total_bytes) || 0, this.num(n.tx_total_bytes) || 0, n.status || null, n.ip || null]);
    for (const c of con.slice(0, 1000)) await this.db.query(`insert into connection_metrics(server_id,port,protocol,established,listening) values($1,$2,$3,$4,$5)`, [id, Number(c.port || 0), String(c.protocol || 'tcp'), Number(c.established || 0), Boolean(c.listening)]);
    await this.db.query(`update servers set status='online',agent_version=coalesce($2,agent_version),last_seen_at=now(),updated_at=now() where id=$1`, [id, agentVersion]);
  }
  async storeAgentLogs(id: string, text: string) { await this.db.query(`update servers set agent_logs=$2,agent_logs_at=now() where id=$1`, [id, String(text || '').slice(0, 20000)]); }
  async getAgentLogs(id: string) { const r = await this.db.query('select agent_logs,agent_logs_at from servers where id=$1', [id]); return { logs: r.rows[0]?.agent_logs || null, at: r.rows[0]?.agent_logs_at || null }; }
  private computeHealthScore(m: any): number {
    let score = 100;
    const cpu = this.num(m.cpu_usage_percent); if (cpu !== null) { if (cpu >= 92) score -= 22; else if (cpu >= 78) score -= 11; else if (cpu >= 60) score -= 4; }
    const ram = this.num(m.memory_usage_percent); if (ram !== null) { if (ram >= 92) score -= 20; else if (ram >= 80) score -= 10; else if (ram >= 65) score -= 4; }
    const disk = this.num(m.disk_usage_percent); if (disk !== null) { if (disk >= 95) score -= 26; else if (disk >= 85) score -= 12; else if (disk >= 75) score -= 5; }
    const err = this.num(m.net_err_per_sec) || 0, drop = this.num(m.net_drop_per_sec) || 0; if (err + drop > 0) score -= Math.min(15, 6 + Math.floor((err + drop) / 10));
    const ping = this.num(m.ping_ms); if (ping !== null) { if (ping >= 250) score -= 10; else if (ping >= 120) score -= 4; }
    if (this.vpnMonitoring && m.vpn_active === false) score -= 25;
    const up = this.num(m.uptime_seconds); if (up !== null && up < 300) score -= 5;
    return Math.max(0, Math.min(100, Math.round(score)));
  }
  private healthLabel(score: number): 'healthy' | 'warning' | 'critical' { if (score >= 85) return 'healthy'; if (score >= 60) return 'warning'; return 'critical'; }
  async latestMetrics(id: string) { const r = await this.db.query('select * from server_metrics where server_id=$1 order by timestamp desc limit 1', [id]); return r.rows[0] || null; }
  async metricsHistory(id: string, range = '1h') {
    const RAW: Record<string, string> = { '30m': '30 minutes', '1h': '1 hour', '2h': '2 hours', '6h': '6 hours' };
    if (RAW[range]) {
      const r = await this.db.query(`select timestamp,cpu_usage_percent::float,memory_usage_percent::float,disk_usage_percent::float,inbound_bps::float,outbound_bps::float,total_connections,health_score,load_1::float,load_5::float,load_15::float,net_err_per_sec,net_drop_per_sec,ping_ms::float from server_metrics where server_id=$1 and timestamp > now() - ($2)::interval order by timestamp asc limit 2000`, [id, RAW[range]]);
      return r.rows;
    }
    const ROLL: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
    const iv = ROLL[range] || '24 hours';
    const r = await this.db.query(`select bucket as timestamp,avg_cpu::float cpu_usage_percent,max_cpu::float,avg_ram::float memory_usage_percent,max_ram::float,avg_disk::float disk_usage_percent,avg_inbound_bps::float inbound_bps,avg_outbound_bps::float outbound_bps,max_connections total_connections,avg_health health_score from metrics_rollup where server_id=$1 and bucket > now() - ($2)::interval order by bucket asc limit 2000`, [id, iv]);
    return r.rows;
  }
  async refreshStatuses() { await this.db.query(`update servers set status=case when status='revoked' then 'revoked' when last_seen_at is null then 'waiting' when last_seen_at < now() - interval '120 seconds' then 'offline' when status='paused' then 'paused' when last_seen_at < now() - interval '30 seconds' then 'warning' else 'online' end`); }
  async queueCommand(id: string, command: string, payload?: any) {
    if (!VALID_COMMANDS.has(command)) throw new BadRequestException('invalid command');
    const s = await this.getInternal(id); if (!s) throw new NotFoundException('server not found');
    // Идемпотентные команды не дублируем: если уже есть pending — возвращаем его, чтобы повторные
    // нажатия «Обновить агента» не копили очередь и агент не перезапускался по нескольку раз.
    if (command === 'update' || command === 'poweroff') {
      const existing = await this.db.query(`select id,server_id,command,status,created_at from server_commands where server_id=$1 and command=$2 and status='pending' order by created_at asc limit 1`, [id, command]);
      if (existing.rows[0]) return existing.rows[0];
    }
    const r = await this.db.query(`insert into server_commands(server_id,command,payload) values($1,$2,$3) returning id,server_id,command,status,created_at`, [id, command, payload ? JSON.stringify(payload) : null]);
    return r.rows[0];
  }
  async listCommands(id: string) { const r = await this.db.query(`select id,command,status,created_at,delivered_at from server_commands where server_id=$1 order by created_at desc limit 20`, [id]); return r.rows; }
  async pendingCommand(id: string) { const r = await this.db.query(`select id,command,payload from server_commands where server_id=$1 and status='pending' order by created_at asc limit 1`, [id]); return r.rows[0] || null; }
  async markCommandDelivered(id: number) { await this.db.query(`update server_commands set status='delivered',delivered_at=now() where id=$1`, [id]); }
  publicServer(row: any) {
    const stale = !LIVE_STATUSES.has(row.status);
    const m = (!stale && row.latest_metrics_at) ? { timestamp: row.latest_metrics_at, hostname: row.hostname, public_ip: row.public_ip, local_ip: row.local_ip, os: row.os, kernel: row.kernel, uptime_seconds: this.num(row.uptime_seconds), cpu_model: row.cpu_model, cpu_cores: this.num(row.cpu_cores), cpu_threads: this.num(row.cpu_threads), cpu_usage_percent: this.num(row.cpu_usage_percent), load_1: this.num(row.load_1), load_5: this.num(row.load_5), load_15: this.num(row.load_15), memory_total_bytes: this.num(row.memory_total_bytes), memory_used_bytes: this.num(row.memory_used_bytes), memory_free_bytes: this.num(row.memory_free_bytes), memory_usage_percent: this.num(row.memory_usage_percent), swap_total_bytes: this.num(row.swap_total_bytes), swap_used_bytes: this.num(row.swap_used_bytes), swap_usage_percent: this.num(row.swap_usage_percent), disk_total_bytes: this.num(row.disk_total_bytes), disk_used_bytes: this.num(row.disk_used_bytes), disk_free_bytes: this.num(row.disk_free_bytes), disk_usage_percent: this.num(row.disk_usage_percent), inbound_bps: this.num(row.inbound_bps), outbound_bps: this.num(row.outbound_bps), total_connections: this.num(row.total_connections), agent_latency_ms: this.num(row.agent_latency_ms), net_err_per_sec: this.num(row.net_err_per_sec), net_drop_per_sec: this.num(row.net_drop_per_sec), ping_ms: this.num(row.ping_ms), vpn_active: row.vpn_active === null || row.vpn_active === undefined ? null : Boolean(row.vpn_active), vpn_service: row.vpn_service || null, top_cpu: row.top_cpu || null, top_mem: row.top_mem || null, health_score: this.num(row.health_score), bridges: row.bridges || null, raw: row.raw } : null;
    const secondsSinceSeen = row.last_seen_at ? Math.max(0, Math.floor((Date.now() - new Date(row.last_seen_at).getTime()) / 1000)) : null;
    let health: { score: number; label: string } | null = null;
    if (row.status === 'offline') health = { score: 0, label: 'offline' };
    else if (row.status === 'paused') health = { score: this.num(row.health_score) ?? 0, label: 'paused' };
    else if (LIVE_STATUSES.has(row.status) && row.latest_metrics_at) { const score = this.computeHealthScore(row); health = { score, label: this.healthLabel(score) }; }
    const agentStale = LIVE_STATUSES.has(row.status) && row.status !== 'paused' && secondsSinceSeen !== null && secondsSinceSeen > 60;
    return { id: row.id, name: row.name, ip: row.ip, port: row.port, description: row.description, tags: row.tags || [], category: row.category || 'other', country: row.country || null, status: row.status, last_seen_at: row.last_seen_at, created_at: row.created_at, agent_version: row.agent_version || null, agent_latency_ms: m?.agent_latency_ms ?? null, vpn_active: m?.vpn_active ?? null, vpn_service: m?.vpn_service ?? null, bridges: m?.bridges ?? null, seconds_since_seen: secondsSinceSeen, agent_stale: agentStale, health, latestMetrics: m };
  }
  installCommand(id: string, token: string) { const u = process.env.PANEL_PUBLIC_URL || ''; return `curl -fsSL ${u}/install.sh -o install-eclipse-agent.sh && chmod +x install-eclipse-agent.sh && sudo ./install-eclipse-agent.sh --panel-url ${u} --server-id ${id} --token ${token}`; }
  private listSql() { return `select s.id,s.name,s.ip,s.port,s.description,s.tags,s.category,s.country,s.status,s.last_seen_at,s.created_at,s.agent_version,s.agent_logs_at,m.hostname,m.public_ip,m.local_ip,m.os,m.kernel,m.uptime_seconds,m.cpu_model,m.cpu_cores,m.cpu_threads,m.cpu_usage_percent,m.load_1,m.load_5,m.load_15,m.memory_total_bytes,m.memory_used_bytes,m.memory_free_bytes,m.memory_usage_percent,m.swap_total_bytes,m.swap_used_bytes,m.swap_usage_percent,m.disk_total_bytes,m.disk_used_bytes,m.disk_free_bytes,m.disk_usage_percent,m.inbound_bps,m.outbound_bps,m.total_connections,m.agent_latency_ms,m.net_err_per_sec,m.net_drop_per_sec,m.ping_ms,m.vpn_active,m.vpn_service,m.top_cpu,m.top_mem,m.health_score,m.bridges,m.raw,m.timestamp as latest_metrics_at from servers s left join lateral (select * from server_metrics sm where sm.server_id=s.id order by sm.timestamp desc limit 1) m on true`; }
  private num(v: any): number | null { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
}
