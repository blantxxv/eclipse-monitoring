import { Injectable, OnModuleInit } from '@nestjs/common';
import { Pool, QueryResult } from 'pg';
import * as bcrypt from 'bcrypt';

const METRICS_RETENTION_MINUTES = Number(process.env.METRICS_RETENTION_MINUTES || 120);
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class DbService implements OnModuleInit {
  private pool: Pool;
  constructor() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://eclipse:change_me@postgres:5432/eclipse' });
  }
  query<T = any>(text: string, params: any[] = []): Promise<QueryResult<T>> { return this.pool.query<T>(text, params); }
  async onModuleInit() {
    await this.query('select 1');
    await this.migrate();
    await this.ensureAdmin();
    await this.rollup().catch((e) => console.error('rollup error:', e));
    await this.cleanup();
    setInterval(() => {
      this.rollup().catch((e) => console.error('rollup error:', e));
      this.cleanup().catch((e) => console.error('cleanup error:', e));
    }, CLEANUP_INTERVAL_MS);
  }
  private async migrate() {
    await this.query(`create extension if not exists pgcrypto;`);
    await this.query(`create table if not exists users (id uuid primary key default gen_random_uuid(), email text unique not null, password_hash text not null, role text not null default 'admin', created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
    await this.query(`create table if not exists servers (id uuid primary key default gen_random_uuid(), name text not null, ip text not null, port integer not null default 3406, description text, tags text[] not null default '{}', status text not null default 'waiting', agent_secret_enc text, enrollment_token_hash text, enrollment_expires_at timestamptz, last_seen_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
    await this.query(`create table if not exists server_metrics (id bigserial primary key, server_id uuid not null references servers(id) on delete cascade, timestamp timestamptz not null default now(), hostname text, public_ip text, local_ip text, os text, kernel text, uptime_seconds bigint, cpu_model text, cpu_cores integer, cpu_threads integer, cpu_usage_percent numeric, load_1 numeric, load_5 numeric, load_15 numeric, memory_total_bytes bigint, memory_used_bytes bigint, memory_free_bytes bigint, memory_usage_percent numeric, swap_total_bytes bigint, swap_used_bytes bigint, swap_usage_percent numeric, disk_total_bytes bigint, disk_used_bytes bigint, disk_free_bytes bigint, disk_usage_percent numeric, inbound_bps bigint, outbound_bps bigint, total_connections integer, raw jsonb, created_at timestamptz not null default now());`);
    await this.query(`create table if not exists network_metrics (id bigserial primary key, server_id uuid not null references servers(id) on delete cascade, timestamp timestamptz not null default now(), interface text not null, rx_bytes_per_sec bigint, tx_bytes_per_sec bigint, rx_total_bytes bigint, tx_total_bytes bigint, status text, ip text, created_at timestamptz not null default now());`);
    await this.query(`create table if not exists connection_metrics (id bigserial primary key, server_id uuid not null references servers(id) on delete cascade, timestamp timestamptz not null default now(), port integer not null, protocol text not null default 'tcp', established integer not null default 0, listening boolean not null default false, created_at timestamptz not null default now());`);
    await this.query(`create table if not exists replay_nonces (server_id uuid not null, ts text not null, signature text not null, created_at timestamptz not null default now(), primary key (server_id, ts, signature));`);
    await this.query(`create table if not exists server_commands (id bigserial primary key, server_id uuid not null references servers(id) on delete cascade, command text not null, status text not null default 'pending', created_at timestamptz not null default now(), delivered_at timestamptz);`);
    await this.query(`create table if not exists settings (key text primary key, value text, updated_at timestamptz not null default now());`);
    await this.query(`create table if not exists alert_state (server_id uuid not null, kind text not null, active boolean not null default false, since timestamptz, last_notified_at timestamptz, primary key (server_id, kind));`);
    await this.query(`create table if not exists alert_log (id bigserial primary key, server_id uuid references servers(id) on delete cascade, server_name text, kind text not null, level text not null default 'warning', message text not null, created_at timestamptz not null default now());`);
    await this.query(`create table if not exists auth_attempts (id bigserial primary key, email text, ip text, success boolean not null, user_agent text, created_at timestamptz not null default now());`);
    await this.query(`create table if not exists blocked_ips (ip text primary key, reason text, blocked_at timestamptz not null default now(), blocked_by text);`);
    // --- workpack 2026-07: agent freshness, health, vpn, top processes ---
    await this.query(`alter table server_metrics add column if not exists agent_version text;`);
    await this.query(`alter table server_metrics add column if not exists agent_latency_ms integer;`);
    await this.query(`alter table server_metrics add column if not exists net_err_per_sec bigint;`);
    await this.query(`alter table server_metrics add column if not exists net_drop_per_sec bigint;`);
    await this.query(`alter table server_metrics add column if not exists ping_ms numeric;`);
    await this.query(`alter table server_metrics add column if not exists vpn_active boolean;`);
    await this.query(`alter table server_metrics add column if not exists vpn_service text;`);
    await this.query(`alter table server_metrics add column if not exists top_cpu jsonb;`);
    await this.query(`alter table server_metrics add column if not exists top_mem jsonb;`);
    await this.query(`alter table server_metrics add column if not exists health_score integer;`);
    await this.query(`alter table servers add column if not exists agent_version text;`);
    await this.query(`alter table servers add column if not exists agent_logs text;`);
    await this.query(`alter table servers add column if not exists agent_logs_at timestamptz;`);
    await this.query(`alter table servers add column if not exists category text not null default 'other';`);
    await this.query(`alter table servers add column if not exists position integer;`);
    // ISO-код страны ноды (ru/de/nl…) — рисуем флаг рядом с именем и точку на карте флота.
    await this.query(`alter table servers add column if not exists country text;`);
    await this.query(`alter table server_metrics add column if not exists bridges jsonb;`);
    await this.query(`alter table server_commands add column if not exists payload jsonb;`);
    // Отслеживание состояния мостов во времени (для алерта «down > 5 мин» и «нерабочий > 1 ч»).
    await this.query(`create table if not exists bridge_state (server_id uuid not null references servers(id) on delete cascade, bridge text not null, status text not null, since timestamptz not null default now(), primary key (server_id, bridge));`);
    // disabled=true — мост лежит > 1 ч, мониторинг по нему отключён (не шлём алерты до восстановления).
    await this.query(`alter table bridge_state add column if not exists disabled boolean not null default false;`);
    // Grouped incidents (an alert from first trigger to resolution).
    await this.query(`create table if not exists incidents (id bigserial primary key, server_id uuid references servers(id) on delete cascade, server_name text, kind text not null, level text not null default 'warning', message text, started_at timestamptz not null default now(), resolved_at timestamptz, duration_seconds integer, telegram_notified boolean not null default false, status text not null default 'open');`);
    // Hourly downsampled metrics for the long-range analytics tab.
    await this.query(`create table if not exists metrics_rollup (server_id uuid not null references servers(id) on delete cascade, bucket timestamptz not null, avg_cpu numeric, max_cpu numeric, avg_ram numeric, max_ram numeric, avg_disk numeric, avg_inbound_bps numeric, avg_outbound_bps numeric, max_connections integer, avg_health integer, samples integer not null default 0, primary key (server_id, bucket));`);
    await this.query(`create index if not exists idx_server_metrics_server_time on server_metrics(server_id, timestamp desc);`);
    await this.query(`create index if not exists idx_network_metrics_server_time on network_metrics(server_id, timestamp desc);`);
    await this.query(`create index if not exists idx_connection_metrics_server_time on connection_metrics(server_id, timestamp desc);`);
    await this.query(`create index if not exists idx_server_commands_pending on server_commands(server_id, status, created_at);`);
    await this.query(`create index if not exists idx_alert_log_time on alert_log(created_at desc);`);
    await this.query(`create index if not exists idx_auth_attempts_time on auth_attempts(created_at desc);`);
    await this.query(`create index if not exists idx_incidents_time on incidents(started_at desc);`);
    await this.query(`create index if not exists idx_incidents_open on incidents(server_id, kind) where status='open';`);
    await this.query(`create index if not exists idx_metrics_rollup_bucket on metrics_rollup(server_id, bucket desc);`);
  }
  private async ensureAdmin() {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const exists = await this.query('select id from users where email=$1', [email]);
    if (exists.rowCount) return;
    const hash = await bcrypt.hash(password, 12);
    await this.query('insert into users(email, password_hash, role) values($1,$2,$3)', [email, hash, 'admin']);
    console.log(`Created admin user: ${email}`);
  }
  async cleanup() {
    await this.query(`delete from replay_nonces where created_at < now() - interval '2 minutes'`);
    await this.query(`delete from server_metrics where timestamp < now() - ($1 || ' minutes')::interval`, [METRICS_RETENTION_MINUTES]);
    await this.query(`delete from network_metrics where timestamp < now() - ($1 || ' minutes')::interval`, [METRICS_RETENTION_MINUTES]);
    await this.query(`delete from connection_metrics where timestamp < now() - ($1 || ' minutes')::interval`, [METRICS_RETENTION_MINUTES]);
    await this.query(`delete from server_commands where status <> 'pending' and created_at < now() - interval '7 days'`);
    await this.query(`delete from alert_log where created_at < now() - interval '14 days'`);
    await this.query(`delete from auth_attempts where created_at < now() - interval '30 days'`);
    await this.query(`delete from metrics_rollup where bucket < now() - interval '31 days'`);
    await this.query(`delete from incidents where status='resolved' and resolved_at < now() - interval '31 days'`);
  }

  // Downsample raw metrics into hourly buckets so the analytics tab can show
  // 24h / 7d / 30d ranges long after the raw rows have been pruned. Idempotent:
  // re-aggregates the last few hours each tick until the raw rows age out.
  async rollup() {
    await this.query(`
      insert into metrics_rollup (server_id, bucket, avg_cpu, max_cpu, avg_ram, max_ram, avg_disk, avg_inbound_bps, avg_outbound_bps, max_connections, avg_health, samples)
      select server_id,
             date_trunc('hour', timestamp) as bucket,
             avg(cpu_usage_percent), max(cpu_usage_percent),
             avg(memory_usage_percent), max(memory_usage_percent),
             avg(disk_usage_percent),
             avg(inbound_bps), avg(outbound_bps),
             max(total_connections),
             round(avg(health_score))::int,
             count(*)::int
      from server_metrics
      where timestamp > now() - interval '3 hours'
      group by server_id, date_trunc('hour', timestamp)
      on conflict (server_id, bucket) do update set
        avg_cpu=excluded.avg_cpu, max_cpu=excluded.max_cpu,
        avg_ram=excluded.avg_ram, max_ram=excluded.max_ram,
        avg_disk=excluded.avg_disk,
        avg_inbound_bps=excluded.avg_inbound_bps, avg_outbound_bps=excluded.avg_outbound_bps,
        max_connections=excluded.max_connections, avg_health=excluded.avg_health,
        samples=excluded.samples`);
  }
}
