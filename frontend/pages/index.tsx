import Head from 'next/head';
import { FormEvent, MouseEvent as ReactMouseEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Status = 'waiting' | 'online' | 'warning' | 'paused' | 'offline' | 'revoked';
type Tab = 'nodes' | 'problems' | 'metrics' | 'incidents' | 'alerts' | 'updates' | 'settings';

type Health = { score: number; label: 'healthy' | 'warning' | 'critical' | 'paused' | 'offline' } | null;
type Proc = { pid: number; name: string; cpu: number; mem: number };
type Bridge = { backend: string; name: string; addr?: string; status: string; sessions: number; smax?: number; bytes_in?: number; bytes_out?: number; check_status?: string; downtime?: number; last_change?: number };
type AgentCommand = 'start' | 'stop' | 'restart' | 'delete' | 'update' | 'check-config' | 'logs' | 'bridge-check';
type Category = 'bs' | 'wifi' | 'bridge' | 'other';

type Metrics = {
  timestamp?: string;
  hostname?: string;
  os?: string;
  kernel?: string;
  uptime_seconds?: number;
  cpu_model?: string;
  cpu_cores?: number;
  cpu_threads?: number;
  cpu_usage_percent?: number;
  memory_total_bytes?: number;
  memory_used_bytes?: number;
  memory_free_bytes?: number;
  memory_usage_percent?: number;
  swap_total_bytes?: number;
  swap_used_bytes?: number;
  swap_usage_percent?: number;
  disk_total_bytes?: number;
  disk_used_bytes?: number;
  disk_free_bytes?: number;
  disk_usage_percent?: number;
  inbound_bps?: number;
  outbound_bps?: number;
  total_connections?: number;
  agent_latency_ms?: number | null;
  net_err_per_sec?: number | null;
  net_drop_per_sec?: number | null;
  ping_ms?: number | null;
  vpn_active?: boolean | null;
  vpn_service?: string | null;
  top_cpu?: Proc[] | null;
  top_mem?: Proc[] | null;
  health_score?: number | null;
  bridges?: Bridge[] | null;
  raw?: any;
};

type Server = {
  id: string;
  name: string;
  ip: string;
  port: number;
  status: Status;
  last_seen_at?: string;
  created_at: string;
  category?: Category;
  country?: string | null;
  agent_version?: string | null;
  agent_latency_ms?: number | null;
  vpn_active?: boolean | null;
  vpn_service?: string | null;
  bridges?: Bridge[] | null;
  seconds_since_seen?: number | null;
  agent_stale?: boolean;
  health?: Health;
  latestMetrics?: Metrics | null;
};

type Summary = {
  total: number;
  online: number;
  waiting: number;
  warning: number;
  paused: number;
  offline: number;
  revoked: number;
  alerts_24h?: number;
  alerts_unread?: number;
  open_incidents?: number;
  average_cpu?: number;
  average_ram?: number;
  average_load?: number;
  average_health?: number;
  total_inbound_bps?: number;
  total_outbound_bps?: number;
  total_connections?: number;
  total_ram_bytes?: number;
  total_transferred_bytes?: number;
};

type ProblemsData = {
  offline: { id: string; name: string; ip: string; last_seen_at?: string }[];
  agentStale: { id: string; name: string; seconds: number }[];
  highLoad: { id: string; name: string; kind: string; since?: string }[];
  vpnDown: { id: string; name: string; vpn_service?: string }[];
  bridgesDown: { id: string; name: string; backend: string; bridge: string; addr?: string; status: string }[];
  outdatedAgents: { id: string; name: string; agent_version?: string | null; status: Status }[];
  duplicateIps?: { ip: string; cnt: number; names: string }[];
  telegram: { level: string; message: string }[];
  total: number;
};

type VersionsData = {
  backend: string;
  frontend: string;
  agentLatest: string;
  buildHash: string;
  buildTime: string | null;
  counts: { total: number; upToDate: number; outdated: number; unknown: number };
  agents: { id: string; name: string; agent_version?: string | null; status: Status; outdated: boolean; unknown: boolean }[];
};

type Incident = {
  id: number;
  server_id: string;
  server_name: string;
  kind: string;
  level: 'info' | 'warning' | 'critical';
  message: string;
  started_at: string;
  resolved_at?: string;
  duration_seconds?: number;
  telegram_notified: boolean;
  status: 'open' | 'resolved';
};

type AlertEntry = {
  id: number;
  server_id: string;
  server_name: string;
  kind: string;
  level: 'info' | 'warning' | 'critical';
  message: string;
  created_at: string;
};

type CommandEntry = { id: number; command: string; status: string; created_at: string; delivered_at?: string };

type UpdateState = {
  status?: 'idle' | 'running' | 'error' | string;
  message?: string;
  localShort?: string;
  remoteShort?: string;
  behind?: number;
  updateAvailable?: boolean;
  latestSubject?: string;
  checkedAt?: string;
  currentBranch?: string;
};

type PanelUpdate = {
  versions: { backend: string; frontend: string; agentLatest: string; buildHash: string; buildTime: string | null };
  channelReady: boolean;
  state: UpdateState | null;
};

type SettingsData = {
  telegramConfigured: boolean;
  telegramChatIds: string[];
  vpnMonitoring: boolean;
  bridgeMonitoring: boolean;
  thresholds: { cpuPercent: number; ramPercent: number; diskPercent: number; sustainedMinutes: number; trafficMbps: number; bridgeSessions: number; bridgeDownMinutes: number };
};

type AuthAttempt = { id: number; email: string; ip: string; success: boolean; user_agent: string; created_at: string };
type BlockedIp = { ip: string; reason: string; blocked_at: string; blocked_by: string };

// Фолбэк на случай, если /api/versions ещё не загрузился; актуальное значение приходит с бэкенда
// (versions.agentLatest). Держать синхронно с AGENT_LATEST_VERSION в backend/src/common/version.ts.
const AGENT_LATEST_VERSION = '1.7.1';

const categoryLabel: Record<Category, string> = { bs: 'БС', wifi: 'WiFi', bridge: 'Мост', other: 'Прочее' };
const CATEGORY_FILTERS: { key: 'all' | Category; label: string }[] = [
  { key: 'all', label: 'ВСЕ' },
  { key: 'bs', label: 'БС' },
  { key: 'wifi', label: 'WiFi' },
  { key: 'bridge', label: 'МОСТЫ' },
  { key: 'other', label: 'Прочее' },
];

const CHANGELOG = `v2.0.0 — 2026-08
• Полный редизайн панели: сайдбар с подписями, крупные KPI, компактная полоса метрик, анимации
• Флаги стран у нод: колонка country, выбор страны в карточке ноды и при добавлении
• Карта флота: точки по странам, зум колесом и перетаскивание, пресеты Мир/Европа/СНГ/Азия
• Панель «География» и «Топ нод по нагрузке», лента событий в реальном времени
• Режимы просмотра нод: таблица, карточки, стена (плитка с заливкой по health score)
• Командная палитра по Ctrl+K: поиск нод по имени, IP и стране, переходы по разделам
• Графики: ось времени с датами — диапазоны 24ч/7д/30д теперь отличаются визуально
• График трафика флота (суммарно по всем нодам) на вкладке «Ноды»
• Обновление панели из интерфейса: проверка и установка новой версии с GitHub
• Установка на чистый сервер одной командой с указанием домена

v1.6.5 — 2026-07
• Запрет дубликатов по IP: нельзя добавить ноду с уже занятым IP (при переустановке агента — переиздать команду у существующей ноды)
• Группа «Дубли по IP» в «Проблемах» — ловит две записи на одну машину (источник ложных offline)

v1.6.4 — 2026-07
• Порог «Мост недоступен от, мин» — настраивается (было жёстко 5 мин)
• Переключатель «Мониторинг мостов» — полностью отключает алерты по мостам (недоступен/перегружен)
• Меньше ложных «сервер недоступен»: алерт только если нода молчит ≥ 3 мин, плюс пауза на алерты первые минуты после перезапуска панели (переживаем редеплой без ложных срабатываний)

v1.6.3 — 2026-07
• Переименование нод (меню ноды → «Переименовать», либо ✎ в окне ноды)
• Порог «Длительность» теперь работает для всех метрик (CPU/RAM/диск/трафик): алерт приходит только если показатель держится выше порога дольше заданного времени

v1.6.2 / агент 1.7.1 — 2026-07
• Исправлен подсчёт скорости: трафик считается только по реальному NIC (исключены VPN-туннели wg/tun/tap) — больше нет завышения в разы
• Скорость делится на реально прошедшее время между замерами (агент), а не на номинальный интервал
• Мосты: один алерт при недоступности 5 мин (без повторов каждые 30 мин); при недоступности > 1 ч мониторинг по мосту отключается до восстановления
• Меньше уведомлений в целом (нет ложных трафик-алертов из-за завышенной скорости)
• Новые ноды появляются сверху списка (а не в самом низу)
• Надёжное обновление агента: перезапуск после апдейта больше не срывается; повторные нажатия «Обновить» не копят очередь команд

v1.6.1 — 2026-07
• Перетаскивание нод мышью за ручку (drag-and-drop)
• Инциденты «мёртвых»/исчезнувших мостов закрываются (счётчик не висит вечно)
• Бейджи «Проблемы»/«Инциденты» гасятся при открытии вкладки

v1.6.0 / агент 1.7.0 — 2026-07
• Трафик считается только по физ. интерфейсам (исключены ifb/veth/docker/lo/br-) — больше нет завышения из-за ingress-shaping
• Мосты: алерт только если лежит 5–60 мин; >1 ч — «нерабочий», без ежеминутных уведомлений
• Нет трафик-алертов для категорий «Мост» и «WiFi»
• Локальные бэкенды (127.0.0.1, заглушки) больше не считаются мостами
• Если haproxy выключен — мосты пропадают (агент не берёт их из старого конфига)
• Счётчик алертов обнуляется при открытии вкладки
• Перемещение нод (вверх/вниз в меню ноды)
• Кнопка экстренного выключения серверов по категориям (Настройки)
• Фикс «агент молчит»: сбор мостов кэшируется, collect не роняет цикл

v1.5.0 / агент 1.6.0 — 2026-07
• Детект мостов HAProxy устойчив к разным путям: обычный stats-сокет → master-сокет (@1 show stat) → парсинг haproxy.cfg + TCP-проба
• Мосты показываются даже если в конфиге нет «stats socket»

v1.4.0 / агент 1.5.0 — 2026-07
• Исправлен ложный детект VPN (wg-quick@wg0): авто-детект сообщает VPN только если он реально используется (active/enabled)
• Настройка «VPN-мониторинг» (вкл/выкл) — мгновенно убирает health-штраф и алерт «VPN не работает»
• Health пересчитывается на лету (реагирует на настройку сразу)

v1.3.0 / агент 1.4.0 — 2026-07
• Проверка мостов из панели (команда «Проверить мост», TCP-пробы)
• IP моста выводится в алертах и на вкладке «Проблемы»
• Команды агента теперь умеют принимать параметры (payload)

v1.2.0 / агент 1.3.0 — 2026-07
• Мониторинг мостов HAProxy на БС: статус UP/DOWN, сессии, трафик, алерты
• Категории нод: БС / WiFi / Мост / Прочее + фильтр
• Трафик в алертах теперь в Мбит/с (совпадает с порогом)
• Предыдущее: v1.1.0 / агент 1.2.0

v1.1.0 / агент 1.2.0 — 2026-07
• Health score нод (0–100) и средний показатель по флоту
• Свежесть агента: задержка, версия, алерт «агент молчит»
• Команды: обновить агента, проверить конфиг, скачать логи
• Вкладка «Проблемы» — только то, что требует внимания
• Вкладка «Метрики» — история CPU/RAM/диска/сети/health, топ процессов, диапазоны 1ч–30д
• Вкладка «Инциденты» — события от сбоя до восстановления
• Вкладка «Обновления» — версии панели и агентов, массовое обновление
• Агент собирает ошибки/дропы сети, ping и статус VPN-сервиса`;

const statusLabel: Record<Status, string> = {
  waiting: 'Ожидает агента',
  online: 'Онлайн',
  warning: 'Предупреждение',
  paused: 'Приостановлен',
  offline: 'Оффлайн',
  revoked: 'Ключ отозван',
};

const alertKindLabel: Record<string, string> = {
  cpu: 'Нагрузка CPU',
  ram: 'Нагрузка RAM',
  disk: 'Заполнение диска',
  traffic: 'Аномальный трафик',
  offline: 'Недоступность',
};

function kindLabel(kind: string) {
  if (kind.startsWith('bridge_down:')) return `Мост недоступен · ${kind.slice('bridge_down:'.length)}`;
  if (kind.startsWith('bridge_load:')) return `Мост перегружен · ${kind.slice('bridge_load:'.length)}`;
  return alertKindLabel[kind] || kind;
}

const commandLabel: Record<string, string> = {
  start: 'Запустить',
  stop: 'Остановить',
  restart: 'Перезапустить',
  update: 'Обновить агента',
  'check-config': 'Проверить конфиг',
  logs: 'Скачать логи агента',
  'bridge-check': 'Проверить мост',
  delete: 'Удалить агента с ноды',
};

const healthLabelText: Record<string, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  paused: 'Paused',
  offline: 'Offline',
};

function canCommand(status: Status, command: AgentCommand) {
  if (status === 'waiting' || status === 'revoked') return false;
  if (command === 'start') return status === 'paused' || status === 'offline';
  if (command === 'stop') return status === 'online' || status === 'warning';
  if (command === 'update' || command === 'check-config' || command === 'logs' || command === 'bridge-check') return status === 'online' || status === 'warning' || status === 'paused';
  return true;
}

function duration(seconds?: number | null) {
  if (seconds === undefined || seconds === null) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} сек.`;
  if (s < 3600) return `${Math.floor(s / 60)} мин. ${s % 60} сек.`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч. ${Math.floor((s % 3600) / 60)} мин.`;
  return `${Math.floor(s / 86400)} д. ${Math.floor((s % 86400) / 3600)} ч.`;
}

type Toast = { id: number; text: string; kind: 'success' | 'error' | 'info' };
type ConfirmRequest = { title: string; message: string; danger?: boolean; resolve: (v: boolean) => void };
type PromptRequest = { title: string; message: string; initial: string; placeholder?: string; resolve: (v: string | null) => void };

function token() {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('token') || '';
}

async function api(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401 && typeof window !== 'undefined') {
    localStorage.removeItem('token');
    location.reload();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

function pct(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '—';
  return `${Math.round(Number(value) * 10) / 10}%`;
}

function barWidth(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return 0;
  return Math.max(0, Math.min(100, Number(value)));
}

function bytes(value?: number | null) {
  if (!value || value <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  let n = value;
  let i = 0;

  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }

  return `${n.toFixed(n >= 10 ? 1 : 2)} ${units[i]}`;
}

function bps(value?: number | null) {
  return `${bytes(value)}/с`;
}

function when(value?: string) {
  if (!value) return 'никогда';
  return new Date(value).toLocaleString('ru-RU');
}

function ago(value?: string) {
  if (!value) return 'никогда';
  const s = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (s < 60) return `${s} сек. назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин. назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч. назад`;
  return `${Math.floor(s / 86400)} д. назад`;
}

function uptime(seconds?: number) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  if (d > 0) return `${d} д. ${h} ч.`;
  if (h > 0) return `${h} ч. ${m} мин.`;
  return `${m} мин.`;
}

function sumNetwork(server?: Server | null) {
  const interfaces = server?.latestMetrics?.raw?.network;
  if (!Array.isArray(interfaces)) {
    return { rxTotal: 0, txTotal: 0, interfaces: [] as any[] };
  }

  const rxTotal = interfaces.reduce((sum: number, i: any) => sum + Number(i.rx_total_bytes || 0), 0);
  const txTotal = interfaces.reduce((sum: number, i: any) => sum + Number(i.tx_total_bytes || 0), 0);

  return { rxTotal, txTotal, interfaces };
}

// ---- chart ----

type ChartSeries = { key: string; color: string; label: string };

// Формат подписи на оси времени: для длинных диапазонов нужна дата, иначе 24ч/7д/30д выглядят одинаково.
function axisLabel(ts: any, withDate: boolean) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!withDate) return hm;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

function MiniChart({
  title,
  data,
  series,
  unit,
  spanDays,
}: {
  title: string;
  data: any[];
  series: ChartSeries[];
  unit: '%' | 'bps' | 'count';
  spanDays?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const W = 640, H = 168, left = 38, right = 10, top = 10, bottom = 30;
  const plotW = W - left - right, plotH = H - top - bottom;

  const format = (v: number) => (unit === '%' ? pct(v) : unit === 'bps' ? bps(v) : String(Math.round(v)));

  const n = data.length;
  const values = series.map((s) => data.map((d) => Number(d[s.key]) || 0));
  const yMax = unit === '%' ? 100 : Math.max(1, ...values.flat()) * 1.2;

  function xAt(i: number) { return n <= 1 ? left : left + (i / (n - 1)) * plotW; }
  function yAt(v: number) { return top + (1 - Math.min(1, v / yMax)) * plotH; }

  function pathFor(vals: number[]) {
    return vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  }
  function areaFor(vals: number[]) {
    if (!vals.length) return '';
    return `${pathFor(vals)} L ${xAt(vals.length - 1).toFixed(1)},${top + plotH} L ${xAt(0).toFixed(1)},${top + plotH} Z`;
  }

  function onMove(e: ReactMouseEvent<SVGRectElement>) {
    if (!n) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = Math.max(0, Math.min(1, (relX - left) / plotW));
    setHover(Math.round(ratio * (n - 1)));
  }

  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const hoverPoint = hover !== null ? data[hover] : null;

  // Подписи оси времени: 5 отметок, крайние прижаты к краям области построения.
  const tickCount = Math.min(5, n);
  const ticks = n > 1 ? Array.from({ length: tickCount }, (_, i) => Math.round((i * (n - 1)) / (tickCount - 1))) : [];

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        {series.length > 1 && (
          <div className="chart-legend">
            {series.map((s) => (
              <span key={s.key} className="legend-item">
                <i style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
        {series.length === 1 && n > 0 && (
          <span className="chart-current" style={{ color: series[0].color }}>
            {format(values[0][n - 1])}
          </span>
        )}
      </div>

      {n === 0 ? (
        <div className="chart-empty">Недостаточно данных за выбранный период.</div>
      ) : (
        <div className="chart-svg-wrap">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="none">
            {gridLines.map((g) => (
              <line key={g} x1={left} x2={W - right} y1={top + g * plotH} y2={top + g * plotH} className="chart-grid" />
            ))}

            {ticks.map((idx, i) => (
              <g key={`t${idx}-${i}`}>
                <line x1={xAt(idx)} x2={xAt(idx)} y1={top} y2={top + plotH} className="chart-grid" opacity={0.5} />
                <text
                  x={xAt(idx)}
                  y={top + plotH + 16}
                  className="chart-tick"
                  textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
                >
                  {axisLabel(data[idx]?.timestamp, Boolean(spanDays))}
                </text>
              </g>
            ))}

            <text x={2} y={top + 4} className="chart-axis-label">{unit === '%' ? '100%' : format(yMax)}</text>
            <text x={2} y={top + plotH + 4} className="chart-axis-label">0</text>

            {series.map((s, idx) => (
              <g key={s.key}>
                <path d={areaFor(values[idx])} fill={s.color} fillOpacity={0.12} stroke="none" />
                <path d={pathFor(values[idx])} fill="none" stroke={s.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            ))}

            {hover !== null && (
              <g>
                <line x1={xAt(hover)} x2={xAt(hover)} y1={top} y2={top + plotH} className="chart-crosshair" />
                {series.map((s, idx) => (
                  <circle key={s.key} cx={xAt(hover)} cy={yAt(values[idx][hover])} r={3.5} fill={s.color} stroke="var(--chart-surface)" strokeWidth={1.5} />
                ))}
              </g>
            )}

            <rect x={left} y={top} width={plotW} height={plotH} fill="transparent"
              onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </svg>

          {hoverPoint && (
            <div className="chart-tooltip" style={{ left: `${(xAt(hover!) / W) * 100}%` }}>
              <div className="chart-tooltip-time">{new Date(hoverPoint.timestamp).toLocaleString('ru-RU')}</div>
              {series.map((s, idx) => (
                <div key={s.key} className="chart-tooltip-row">
                  <i style={{ background: s.color }} />
                  <span className="muted">{s.label}</span>
                  <strong>{format(values[idx][hover!])}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- флаги стран ----
// Рисуются инлайн-SVG, а не эмодзи: Windows не рендерит эмодзи-флаги (вместо 🇷🇺 показывает буквы «RU»).

const bandsH = (...c: string[]) =>
  c.map((col, i) => <rect key={i} y={(i * 20) / c.length} width={30} height={20 / c.length} fill={col} />);
const bandsV = (...c: string[]) =>
  c.map((col, i) => <rect key={i} x={(i * 30) / c.length} width={30 / c.length} height={20} fill={col} />);
const nordic = (bg: string, cross: string, inner?: string) => (
  <>
    <rect width={30} height={20} fill={bg} />
    {inner && <path d="M9 0h6v20H9zM0 7h30v6H0z" fill={inner} />}
    <path d="M10.4 0h3.2v20h-3.2zM0 8.4h30v3.2H0z" fill={cross} />
  </>
);

const FLAGS: Record<string, ReactNode> = {
  ru: bandsH('#fff', '#0039A6', '#D52B1E'),
  de: bandsH('#000', '#DD0000', '#FFCE00'),
  nl: bandsH('#AE1C28', '#fff', '#21468B'),
  fr: bandsV('#002395', '#fff', '#ED2939'),
  it: bandsV('#009246', '#fff', '#CE2B37'),
  ro: bandsV('#002B7F', '#FCD116', '#CE1126'),
  al: (<><rect width={30} height={20} fill="#E41E20" /><path d="M15 4.2c-1.7 0-2.6 1-3.6 1-.7 0-1.2-.3-1.6-.7l.7 2c-.5.2-1.1.2-1.6.1l1.5 1.6-1 .7 2.2.9-.4 1.1 1.6-.3-.2 1.4 1.3-.9.6 1.5.6-1.5 1.3.9-.2-1.4 1.6.3-.4-1.1 2.2-.9-1-.7 1.5-1.6c-.5.1-1.1.1-1.6-.1l.7-2c-.4.4-.9.7-1.6.7-1 0-1.9-1-3.6-1Z" fill="#000" /></>),
  no: nordic('#BA0C2F', '#00205B', '#fff'),
  se: nordic('#006AA7', '#FECC00'),
  fi: nordic('#fff', '#003580'),
  dk: nordic('#C8102E', '#fff'),
  is: nordic('#02529C', '#DC1E35', '#fff'),
  tr: (<><rect width={30} height={20} fill="#E30A17" /><circle cx={11.5} cy={10} r={5} fill="#fff" /><circle cx={13.2} cy={10} r={4} fill="#E30A17" /><path d="m18.4 10.9-1.5-.5 1.5-.5-.9-1.3 1.4.8.1-1.6.5 1.5 1.2-1-.5 1.5 1.6.1-1.4.8 1.4.8-1.6.1.5 1.5-1.2-1-.5 1.5-.1-1.6-1.4.8z" fill="#fff" /></>),
  kz: (<><rect width={30} height={20} fill="#00AFCA" /><circle cx={16} cy={9} r={3.4} fill="#FEC50C" /><path d="M16 3.6V2.2M16 15.8v1.4M10.6 9H9.2M22.8 9h1.4M12.2 5.2l-1-1M19.8 12.8l1 1M19.8 5.2l1-1M12.2 12.8l-1 1" stroke="#FEC50C" strokeWidth={1} /><path d="M2 3v14" stroke="#FEC50C" strokeWidth={1.4} /></>),
  us: (<>{[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={i} y={(i * 20) / 7} width={30} height={20 / 7} fill={i % 2 ? '#fff' : '#B22234'} />)}<rect width={13} height={(20 / 7) * 4} fill="#3C3B6E" /><g fill="#fff">{[0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4].map((c) => <circle key={`${r}${c}`} cx={1.6 + c * 2.6 + (r % 2 ? 1.3 : 0)} cy={1.5 + r * 2.6} r={0.62} />))}</g></>),
  gb: (<><rect width={30} height={20} fill="#012169" /><path d="M0 0l30 20M30 0L0 20" stroke="#fff" strokeWidth={4} /><path d="M0 0l30 20M30 0L0 20" stroke="#C8102E" strokeWidth={2} /><path d="M15 0v20M0 10h30" stroke="#fff" strokeWidth={6.6} /><path d="M15 0v20M0 10h30" stroke="#C8102E" strokeWidth={4} /></>),
  pl: bandsH('#fff', '#DC143C'),
  ua: bandsH('#0057B7', '#FFD700'),
  by: bandsH('#CE1720', '#4AA657'),
  at: bandsH('#ED2939', '#fff', '#ED2939'),
  cz: (<><rect width={30} height={10} fill="#fff" /><rect y={10} width={30} height={10} fill="#D7141A" /><path d="M0 0l15 10L0 20z" fill="#11457E" /></>),
  ee: bandsH('#0072CE', '#000', '#fff'),
  lv: (<><rect width={30} height={20} fill="#9E3039" /><rect y={8} width={30} height={4} fill="#fff" /></>),
  lt: bandsH('#FDB913', '#006A44', '#C1272D'),
  sk: (<><rect width={30} height={20} fill="#fff" /><rect y={6.67} width={30} height={6.67} fill="#0B4EA2" /><rect y={13.33} width={30} height={6.67} fill="#EE1C25" /><path d="M7 5h6v7a3 3 0 0 1-3 3 3 3 0 0 1-3-3z" fill="#EE1C25" stroke="#fff" strokeWidth={0.8} /></>),
  hu: bandsH('#CE2939', '#fff', '#477050'),
  be: bandsV('#000', '#FAE042', '#ED2939'),
  es: (<><rect width={30} height={20} fill="#AA151B" /><rect y={5} width={30} height={10} fill="#F1BF00" /></>),
  pt: (<><rect width={30} height={20} fill="#DA291C" /><rect width={12} height={20} fill="#046A38" /><circle cx={12} cy={10} r={3.6} fill="#FFE900" stroke="#046A38" strokeWidth={0.6} /></>),
  ie: bandsV('#169B62', '#fff', '#FF883E'),
  gr: (<><rect width={30} height={20} fill="#fff" />{[0, 2, 4, 6, 8].map((i) => <rect key={i} y={(i * 20) / 9} width={30} height={20 / 9} fill="#0D5EAF" />)}<rect width={11.1} height={11.1} fill="#0D5EAF" /><path d="M4.4 0h2.3v11.1H4.4zM0 4.4h11.1v2.3H0z" fill="#fff" /></>),
  bg: bandsH('#fff', '#00966E', '#D62612'),
  rs: bandsH('#C6363C', '#0C4076', '#fff'),
  md: bandsV('#0046AE', '#FFD200', '#CC0000'),
  cy: (<><rect width={30} height={20} fill="#fff" /><path d="M11 6.5c2.5-1.4 6-1.2 8.4.6-2 1.6-5.6 2.2-8.4.6z" fill="#D57800" /></>),
  lu: bandsH('#ED2939', '#fff', '#00A1DE'),
  ca: (<><rect width={30} height={20} fill="#fff" /><rect width={7.5} height={20} fill="#FF0000" /><rect x={22.5} width={7.5} height={20} fill="#FF0000" /><path d="m15 4.6 1.1 2.6 2.4-1-1 2.6 2.5.6-2 1.5.5 1.4-2.6-.5-.2 3h-1.4l-.2-3-2.6.5.5-1.4-2-1.5 2.5-.6-1-2.6 2.4 1z" fill="#FF0000" /></>),
  cn: (<><rect width={30} height={20} fill="#DE2910" /><path d="m5.5 3 .9 2.7H9l-2.2 1.6.8 2.7-2.2-1.7-2.2 1.7.8-2.7L2 5.7h2.6z" fill="#FFDE00" /><circle cx={11.5} cy={3.2} r={0.9} fill="#FFDE00" /><circle cx={13.5} cy={5.4} r={0.9} fill="#FFDE00" /><circle cx={13.5} cy={8.4} r={0.9} fill="#FFDE00" /><circle cx={11.5} cy={10.5} r={0.9} fill="#FFDE00" /></>),
  in: (<><rect width={30} height={6.67} fill="#FF9933" /><rect y={6.67} width={30} height={6.67} fill="#fff" /><rect y={13.33} width={30} height={6.67} fill="#138808" /><circle cx={15} cy={10} r={2.6} fill="none" stroke="#000080" strokeWidth={0.7} /></>),
  br: (<><rect width={30} height={20} fill="#009B3A" /><path d="M15 2.6 27.4 10 15 17.4 2.6 10z" fill="#FEDF00" /><circle cx={15} cy={10} r={4.2} fill="#002776" /></>),
  au: (<><rect width={30} height={20} fill="#012169" /><g transform="scale(0.5)"><rect width={30} height={20} fill="#012169" /><path d="M0 0l30 20M30 0L0 20" stroke="#fff" strokeWidth={4} /><path d="M0 0l30 20M30 0L0 20" stroke="#C8102E" strokeWidth={2} /><path d="M15 0v20M0 10h30" stroke="#fff" strokeWidth={6.6} /><path d="M15 0v20M0 10h30" stroke="#C8102E" strokeWidth={4} /></g><circle cx={7.5} cy={15} r={1.4} fill="#fff" /><circle cx={22} cy={5} r={1} fill="#fff" /><circle cx={24} cy={11} r={1} fill="#fff" /><circle cx={20} cy={14} r={1} fill="#fff" /><circle cx={25.5} cy={15.5} r={0.8} fill="#fff" /></>),
  kr: (<><rect width={30} height={20} fill="#fff" /><path d="M15 6.5a3.5 3.5 0 0 1 0 7 3.5 3.5 0 0 0 0-7z" fill="#003478" /><path d="M15 6.5a3.5 3.5 0 0 0 0 7 3.5 3.5 0 0 1 0-7z" fill="#CD2E3A" /><circle cx={15} cy={10} r={3.5} fill="none" stroke="none" /></>),
  ch: (<><rect width={30} height={20} fill="#D52B1E" /><path d="M13.4 5h3.2v3.4H20v3.2h-3.4V15h-3.2v-3.4H10V8.4h3.4z" fill="#fff" /></>),
  am: bandsH('#D90012', '#0033A0', '#F2A800'),
  ge: (<><rect width={30} height={20} fill="#fff" /><path d="M12.6 0h4.8v20h-4.8zM0 7.6h30v4.8H0z" fill="#FF0000" /></>),
  ae: (<><rect width={30} height={20} fill="#00732F" /><rect y={6.67} width={30} height={6.67} fill="#fff" /><rect y={13.33} width={30} height={6.67} fill="#000" /><rect width={7.5} height={20} fill="#FF0000" /></>),
  sg: (<><rect width={30} height={20} fill="#fff" /><rect width={30} height={10} fill="#ED2939" /><circle cx={7} cy={5} r={3.2} fill="#fff" /><circle cx={8.6} cy={5} r={3.2} fill="#ED2939" /></>),
  jp: (<><rect width={30} height={20} fill="#fff" /><circle cx={15} cy={10} r={5.5} fill="#BC002D" /></>),
};

const COUNTRY_NAME: Record<string, string> = {
  ru: 'Россия', de: 'Германия', nl: 'Нидерланды', fr: 'Франция', it: 'Италия', ro: 'Румыния',
  al: 'Албания', no: 'Норвегия', se: 'Швеция', fi: 'Финляндия', dk: 'Дания', is: 'Исландия',
  tr: 'Турция', kz: 'Казахстан', us: 'США', gb: 'Британия', pl: 'Польша', ua: 'Украина',
  by: 'Беларусь', ch: 'Швейцария', am: 'Армения', ge: 'Грузия', ae: 'ОАЭ', sg: 'Сингапур', jp: 'Япония',
  at: 'Австрия', cz: 'Чехия', ee: 'Эстония', lv: 'Латвия', lt: 'Литва', sk: 'Словакия',
  hu: 'Венгрия', be: 'Бельгия', es: 'Испания', pt: 'Португалия', ie: 'Ирландия', gr: 'Греция',
  bg: 'Болгария', rs: 'Сербия', md: 'Молдова', cy: 'Кипр', lu: 'Люксембург',
  ca: 'Канада', cn: 'Китай', in: 'Индия', br: 'Бразилия', au: 'Австралия', kr: 'Корея',
};

// координаты (долгота, широта) для точек на карте
const GEO: Record<string, [number, number]> = {
  ru: [37.6, 55.8], de: [10.5, 51], nl: [5.3, 52.2], fr: [2.3, 46.5], it: [12.5, 42.8], ro: [25, 45.9],
  al: [20, 41], no: [9, 60.5], se: [16, 60], fi: [25, 62], dk: [10, 56], is: [-19, 65],
  tr: [33, 39], kz: [68, 48], us: [-98, 39], gb: [-2, 54], pl: [19, 52], ua: [31, 49],
  by: [28, 53.7], ch: [8, 47], am: [45, 40.2], ge: [43.4, 42], ae: [54, 24], sg: [103.8, 1.35], jp: [138, 36],
  at: [14.5, 47.6], cz: [15.5, 49.8], ee: [25.5, 58.8], lv: [24.6, 56.9], lt: [23.9, 55.2], sk: [19.5, 48.7],
  hu: [19.5, 47.2], be: [4.5, 50.6], es: [-3.7, 40.4], pt: [-8.2, 39.5], ie: [-8, 53.3], gr: [22, 39],
  bg: [25.5, 42.7], rs: [21, 44], md: [28.8, 47], cy: [33.4, 35.1], lu: [6.1, 49.8],
  ca: [-106, 56], cn: [104, 35], in: [78.9, 22], br: [-51.9, -14.2], au: [133.8, -25.3], kr: [127.8, 36.5],
};

const COUNTRY_CODES = Object.keys(COUNTRY_NAME);

function countryName(cc?: string | null) {
  return cc ? COUNTRY_NAME[cc] || cc.toUpperCase() : 'Не указана';
}

function Flag({ cc, size }: { cc?: string | null; size?: 'sm' | 'lg' }) {
  const cls = `flag${size ? ` ${size}` : ''}`;
  if (!cc || !FLAGS[cc]) {
    return <span className={`${cls} flag-empty`} title="Страна не указана" />;
  }
  return (
    <span className={cls} title={countryName(cc)}>
      <svg viewBox="0 0 30 20">{FLAGS[cc]}</svg>
    </span>
  );
}

function CountrySelect({ value, onChange, title }: { value?: string | null; onChange: (v: string) => void; title?: string }) {
  return (
    <div className="country-pick" title={title || 'Страна ноды'}>
      <Flag cc={value} size="sm" />
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Без страны</option>
        {COUNTRY_CODES.map((c) => <option key={c} value={c}>{COUNTRY_NAME[c]}</option>)}
      </select>
    </div>
  );
}

// ---- карта флота ----
// Точечная карта: маска суши задана диапазонами колонок по строкам сетки 5°,
// при отрисовке ячейка дробится на k×k точек — плотность растёт с зумом,
// экранный размер точки остаётся постоянным. Точки вне окна не рисуются.

const LAND: Record<number, [number, number][]> = {
  // Ряды 1–2 — арктические острова. Одиночные ячейки убраны: на общем плане они читались
  // не как земля, а как случайные светлые точки в океане.
  1: [[26, 30]],
  2: [[16, 24], [25, 31]],
  3: [[12, 25], [25, 32], [45, 70]],
  4: [[2, 8], [9, 25], [25, 31], [33, 34], [37, 70]],
  5: [[2, 8], [9, 24], [26, 30], [33, 34], [37, 71]],
  6: [[2, 7], [9, 24], [27, 29], [34, 71]],
  7: [[8, 24], [33, 71]],
  8: [[10, 23], [33, 70]],
  9: [[11, 22], [34, 68]],
  10: [[11, 22], [34, 66]],
  11: [[12, 21], [32, 64]],
  12: [[13, 19], [32, 64]],
  13: [[13, 19], [32, 64]],
  14: [[15, 20], [32, 63]],
  15: [[17, 21], [32, 62]],
  16: [[19, 27], [32, 62]],
  17: [[20, 28], [33, 64]],
  18: [[20, 29], [34, 64]],
  19: [[20, 29], [34, 64]],
  20: [[20, 28], [34, 44], [59, 64]],
  21: [[21, 28], [34, 44], [58, 66]],
  22: [[21, 28], [35, 43], [58, 66]],
  23: [[22, 28], [35, 42], [58, 66]],
  24: [[22, 27], [36, 41], [59, 65]],
  25: [[23, 26], [61, 64], [68, 69]],
  26: [[23, 25], [68, 69]],
  27: [[23, 25]],
  28: [[23, 24]],
  29: [[24, 24]],
};

const MAP_W = 144, MAP_H = 60, MAP_AR = MAP_W / MAP_H;
const MAP_PRESETS: Record<string, { cx: number; cy: number; w: number; label: string }> = {
  world: { cx: 72, cy: 30, w: 144, label: 'Мир' },
  europe: { cx: 78, cy: 15.5, w: 26, label: 'Европа' },
  cis: { cx: 96, cy: 14.5, w: 46, label: 'СНГ' },
  asia: { cx: 112, cy: 20, w: 44, label: 'Азия' },
};
const mapX = (lon: number) => (lon + 180) / 2.5;
const mapY = (lat: number) => (90 - lat) / 2.5;

type MapView = { x: number; y: number; w: number; h: number };

function clampMapView(v: MapView): MapView {
  const w = Math.max(9, Math.min(MAP_W, v.w));
  const h = w / MAP_AR;
  return {
    w, h,
    x: Math.max(-6, Math.min(MAP_W + 6 - w, v.x)),
    y: Math.max(-4, Math.min(MAP_H + 4 - h, v.y)),
  };
}
function presetView(name: string): MapView {
  const p = MAP_PRESETS[name];
  return clampMapView({ x: p.cx - p.w / 2, y: p.cy - p.w / MAP_AR / 2, w: p.w, h: p.w / MAP_AR });
}

function FleetMap({ servers, onPickCountry }: { servers: Server[]; onPickCountry: (cc: string) => void }) {
  const [view, setView] = useState<MapView>(() => presetView('world'));
  const [preset, setPreset] = useState('world');
  const [tip, setTip] = useState<{ cc: string; x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; ux: number; uy: number } | null>(null);
  const moved = useRef(false);

  const byCountry = new Map<string, Server[]>();
  servers.forEach((s) => {
    if (!s.country || !GEO[s.country]) return;
    const list = byCountry.get(s.country) || [];
    list.push(s);
    byCountry.set(s.country, list);
  });

  const zoom = MAP_W / view.w;
  const k = Math.min(12, Math.max(2, Math.round(zoom * 2)));
  const step = 2 / k;
  const dotR = step * 0.32;
  const scale = view.w / MAP_W;

  // точки суши с отсечением по видимой области
  const dots: JSX.Element[] = [];
  const x0 = view.x - step, x1 = view.x + view.w + step;
  const y0 = view.y - step, y1 = view.y + view.h + step;
  for (const row of Object.keys(LAND)) {
    const r = Number(row);
    const cy0 = 2 * r;
    if (cy0 > y1 || cy0 + 2 < y0) continue;
    for (const [a, b] of LAND[r]) {
      for (let c = a; c <= b; c++) {
        const cx0 = 2 * c;
        if (cx0 > x1 || cx0 + 2 < x0) continue;
        for (let i = 0; i < k; i++) {
          for (let j = 0; j < k; j++) {
            dots.push(<circle key={`${r}-${c}-${i}-${j}`} cx={cx0 + (j + 0.5) * step} cy={cy0 + (i + 0.5) * step} r={dotR} />);
          }
        }
      }
    }
  }

  function applyZoom(factor: number, ax?: number, ay?: number) {
    setView((v) => {
      const cx = ax ?? v.x + v.w / 2, cy = ay ?? v.y + v.h / 2;
      const nw = Math.max(9, Math.min(MAP_W, v.w / factor));
      const nh = nw / MAP_AR;
      return clampMapView({ x: cx - (cx - v.x) * (nw / v.w), y: cy - (cy - v.y) * (nh / v.h), w: nw, h: nh });
    });
    setPreset('');
  }
  function toMap(e: { clientX: number; clientY: number }): [number, number] {
    const rect = wrapRef.current!.getBoundingClientRect();
    return [view.x + ((e.clientX - rect.left) / rect.width) * view.w, view.y + ((e.clientY - rect.top) / rect.height) * view.h];
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!drag.current) return;
      const d = drag.current;
      if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 3) moved.current = true;
      const dx = (e.clientX - d.px) * d.ux, dy = (e.clientY - d.py) * d.uy;
      d.px = e.clientX; d.py = e.clientY;
      setView((v) => clampMapView({ ...v, x: v.x - dx, y: v.y - dy }));
      setPreset('');
    }
    function onUp() {
      if (!drag.current) return;
      drag.current = null;
      setTimeout(() => { moved.current = false; }, 50);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Колесо вешаем вручную: React-обработчик пассивный и не даёт остановить прокрутку страницы.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const [ax, ay] = toMap(e);
      applyZoom(e.deltaY < 0 ? 1.22 : 1 / 1.22, ax, ay);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const tipServers = tip ? byCountry.get(tip.cc) || [] : [];

  return (
    <div className="map-body">
      <div className="map-canvas" ref={wrapRef}
        onMouseDown={(e) => {
          const rect = wrapRef.current!.getBoundingClientRect();
          drag.current = { px: e.clientX, py: e.clientY, ux: view.w / rect.width, uy: view.h / rect.height };
          moved.current = false;
        }}
        onDoubleClick={(e) => { const [ax, ay] = toMap(e); applyZoom(1.8, ax, ay); }}
      >
        <svg viewBox={`${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}`}
          className={drag.current ? 'grabbing' : ''}>
          <g className="land">{dots}</g>

          {Array.from(byCountry.entries()).map(([cc, list]) => {
            const [lon, lat] = GEO[cc];
            const x = mapX(lon), y = mapY(lat);
            const off = list.some((s) => s.status === 'offline');
            const warn = list.some((s) => s.status === 'warning' || s.status === 'paused');
            const col = off ? '#FF6B6B' : warn ? '#FFC55C' : '#3DDC97';
            // Корень, а не линейный рост: иначе страна с 23 нодами превращается в пятно на пол-карты.
            const r = (1.3 + Math.sqrt(list.length) * 0.75) * scale;
            return (
              <g key={cc} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setTip({ cc, x, y })}
                onMouseLeave={() => setTip(null)}
                onClick={() => { if (!moved.current) onPickCountry(cc); }}
              >
                <circle cx={x} cy={y} r={r * 1.9} fill={col} opacity={0.07} />
                <circle cx={x} cy={y} r={r * 1.45} fill="none" stroke={col} strokeWidth={0.3 * scale} opacity={0.4} />
                {off && <g transform={`translate(${x} ${y}) scale(${scale})`}><circle className="mk-pulse" cx={0} cy={0} /></g>}
                <circle className="mk" cx={x} cy={y} r={r} fill={col} fillOpacity={0.85} strokeWidth={0.6 * scale} />
                <text x={x} y={y + r * 0.36} textAnchor="middle" fill="#04120B" pointerEvents="none"
                  style={{ fontSize: `${(r * 0.95).toFixed(2)}px`, fontWeight: 700, fontFamily: 'Inter, sans-serif' }}>
                  {list.length}
                </text>
                {zoom >= 2.2 && (
                  <text x={x} y={y - r * 2.2} textAnchor="middle" fill="#93A1B0"
                    style={{ fontSize: `${(2.6 * scale).toFixed(2)}px`, fontFamily: 'Inter, sans-serif' }}>
                    {COUNTRY_NAME[cc]}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {tip && (
          <div className="map-tip" style={{ left: `${((tip.x - view.x) / view.w) * 100}%`, top: `${((tip.y - view.y) / view.h) * 100}%` }}>
            <Flag cc={tip.cc} size="sm" />
            <div>
              <b>{COUNTRY_NAME[tip.cc]}</b>
              <div className="s">
                {tipServers.length} нод · {tipServers.filter((s) => s.status === 'online').length} онлайн ·{' '}
                {bps(tipServers.reduce((sum, s) => sum + (s.latestMetrics?.inbound_bps || 0) + (s.latestMetrics?.outbound_bps || 0), 0))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="map-presets">
        {Object.keys(MAP_PRESETS).map((p) => (
          <button key={p} className={preset === p ? 'active' : ''}
            onClick={() => { setView(presetView(p)); setPreset(p); }}>
            {MAP_PRESETS[p].label}
          </button>
        ))}
      </div>

      <div className="map-ctrl">
        <button onClick={() => applyZoom(1.6)} title="Приблизить">+</button>
        <button onClick={() => applyZoom(1 / 1.6)} title="Отдалить">−</button>
        <button onClick={() => { setView(presetView('world')); setPreset('world'); }} title="Сбросить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round"><path d="M4 12a8 8 0 1 1 2.3 5.6" /><path d="M4 17v-5h5" /></svg>
        </button>
      </div>

      <div className="map-zoom-badge">×{zoom.toFixed(1)}</div>
    </div>
  );
}

function GeoPanel({ servers, onPickCountry }: { servers: Server[]; onPickCountry: (cc: string) => void }) {
  const by = new Map<string, Server[]>();
  servers.forEach((s) => {
    const cc = s.country || '';
    const list = by.get(cc) || [];
    list.push(s);
    by.set(cc, list);
  });

  const rows = Array.from(by.entries())
    .map(([cc, list]) => ({
      cc, list,
      traffic: list.reduce((sum, s) => sum + (s.latestMetrics?.inbound_bps || 0) + (s.latestMetrics?.outbound_bps || 0), 0),
    }))
    .sort((a, b) => b.traffic - a.traffic);

  const max = Math.max(1, ...rows.map((r) => r.traffic));

  if (rows.length === 0) return <div className="geo-list"><span className="muted">Нод пока нет.</span></div>;

  return (
    <div className="geo-list">
      {rows.map((r) => (
        <div className="geo-row" key={r.cc || 'none'} onClick={() => onPickCountry(r.cc)}>
          <Flag cc={r.cc} />
          <div style={{ width: 104 }}>
            <div className="geo-name">{countryName(r.cc)}</div>
            <div className="geo-meta">{r.list.length} нод</div>
          </div>
          <div className="geo-dots">
            {r.list.slice(0, 24).map((s) => <i key={s.id} className={s.status} title={`${s.name} — ${statusLabel[s.status]}`} />)}
          </div>
          <div className="geo-bar"><i style={{ width: `${Math.round((r.traffic / max) * 100)}%` }} /></div>
          <div className="geo-val">{bps(r.traffic)}</div>
        </div>
      ))}
    </div>
  );
}

// ---- icons ----

function NodesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x={3.5} y={4} width={17} height={5} rx={1.2} />
      <rect x={3.5} y={14} width={17} height={5} rx={1.2} />
      <circle cx={7} cy={6.5} r={0.9} fill="currentColor" stroke="none" />
      <circle cx={7} cy={16.5} r={0.9} fill="currentColor" stroke="none" />
    </svg>
  );
}

function AlertsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M12 4a5 5 0 0 0-5 5v3.2c0 .7-.24 1.38-.68 1.92L5 16h14l-1.32-1.88A3.1 3.1 0 0 1 17 12.2V9a5 5 0 0 0-5-5Z" strokeLinejoin="round" />
      <path d="M10 19a2 2 0 0 0 4 0" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <line x1={4} y1={7} x2={20} y2={7} />
      <circle cx={9} cy={7} r={1.9} fill="var(--surface)" />
      <line x1={4} y1={12} x2={20} y2={12} />
      <circle cx={15} cy={12} r={1.9} fill="var(--surface)" />
      <line x1={4} y1={17} x2={20} y2={17} />
      <circle cx={11} cy={17} r={1.9} fill="var(--surface)" />
    </svg>
  );
}

function ProblemsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5 21 19H3L12 3.5Z" />
      <line x1={12} y1={10} x2={12} y2={14} />
      <circle cx={12} cy={16.6} r={0.4} fill="currentColor" stroke="none" />
    </svg>
  );
}

function MetricsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M7 15l3.5-4 3 2.5L20 7" />
    </svg>
  );
}

function IncidentsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx={12} cy={12} r={8} />
      <path d="M12 8v4l2.5 2.5" />
    </svg>
  );
}

function UpdatesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" />
      <path d="M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" />
      <path d="M4 20v-4h4" />
    </svg>
  );
}

function HealthBadge({ health }: { health?: Health }) {
  if (!health) return <span className="muted">—</span>;
  return (
    <span className={`health-badge health-${health.label}`} title={`Health score: ${health.score}/100`}>
      <b>{health.score}</b>
      <span>{healthLabelText[health.label] || health.label}</span>
    </span>
  );
}

function HealthRing({ health }: { health?: Health }) {
  if (!health) return <span className="muted">—</span>;
  const color = health.score >= 85 ? 'var(--accent)' : health.score >= 60 ? 'var(--amber)' : 'var(--red)';
  const c = 2 * Math.PI * 15;
  return (
    <div className="health-ring" title={`Health score: ${health.score}/100`}>
      <svg viewBox="0 0 36 36">
        <circle cx={18} cy={18} r={15} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={3.5} />
        <circle cx={18} cy={18} r={15} fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - health.score / 100)} transform="rotate(-90 18 18)" />
      </svg>
      <div className="h-txt">
        {health.score}
        <small>{healthLabelText[health.label] || health.label}</small>
      </div>
    </div>
  );
}

const NAV_GROUPS: { label: string; items: { key: Tab; label: string; icon: () => JSX.Element }[] }[] = [
  { label: 'Обзор', items: [
    { key: 'nodes', label: 'Ноды', icon: NodesIcon },
    { key: 'problems', label: 'Проблемы', icon: ProblemsIcon },
    { key: 'metrics', label: 'Метрики', icon: MetricsIcon },
  ] },
  { label: 'События', items: [
    { key: 'incidents', label: 'Инциденты', icon: IncidentsIcon },
    { key: 'alerts', label: 'Алерты', icon: AlertsIcon },
    { key: 'updates', label: 'Обновления', icon: UpdatesIcon },
  ] },
  { label: 'Система', items: [
    { key: 'settings', label: 'Настройки', icon: SettingsIcon },
  ] },
];

function SidebarNav({ tab, setTab, counts }: {
  tab: Tab;
  setTab: (t: Tab) => void;
  counts: Partial<Record<Tab, { n: number; tone?: 'crit' | 'warn' }>>;
}) {
  return (
    <>
      {NAV_GROUPS.map((g) => (
        <div className="nav-group" key={g.label}>
          <div className="nav-label">{g.label}</div>
          {g.items.map((it) => {
            const Icon = it.icon;
            const c = counts[it.key];
            return (
              <button key={it.key} className={`nav-item ${tab === it.key ? 'active' : ''}`} onClick={() => setTab(it.key)}>
                <Icon />
                {it.label}
                {c && c.n > 0 && <span className={`nav-count ${c.tone || ''}`}>{c.n}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

function NavButtons({ tab, setTab, problemsTotal, alerts24h, openIncidents, outdated }: {
  tab: Tab;
  setTab: (t: Tab) => void;
  problemsTotal: number;
  alerts24h: number;
  openIncidents: number;
  outdated: number;
}) {
  return (
    <>
      <button className={`rail-nav-btn ${tab === 'nodes' ? 'active' : ''}`} title="Ноды" onClick={() => setTab('nodes')}><NodesIcon /></button>
      <button className={`rail-nav-btn ${tab === 'problems' ? 'active' : ''}`} title="Проблемы" onClick={() => setTab('problems')}>
        <ProblemsIcon />
        {problemsTotal > 0 && <span className="rail-nav-badge crit">{problemsTotal}</span>}
      </button>
      <button className={`rail-nav-btn ${tab === 'metrics' ? 'active' : ''}`} title="Метрики" onClick={() => setTab('metrics')}><MetricsIcon /></button>
      <button className={`rail-nav-btn ${tab === 'incidents' ? 'active' : ''}`} title="Инциденты" onClick={() => setTab('incidents')}>
        <IncidentsIcon />
        {openIncidents > 0 && <span className="rail-nav-badge">{openIncidents}</span>}
      </button>
      <button className={`rail-nav-btn ${tab === 'alerts' ? 'active' : ''}`} title="Алерты" onClick={() => setTab('alerts')}>
        <AlertsIcon />
        {alerts24h > 0 && <span className="rail-nav-badge">{alerts24h}</span>}
      </button>
      <button className={`rail-nav-btn ${tab === 'updates' ? 'active' : ''}`} title="Обновления" onClick={() => setTab('updates')}>
        <UpdatesIcon />
        {outdated > 0 && <span className="rail-nav-badge">{outdated}</span>}
      </button>
      <button className={`rail-nav-btn ${tab === 'settings' ? 'active' : ''}`} title="Настройки" onClick={() => setTab('settings')}><SettingsIcon /></button>
    </>
  );
}

// ---- toasts & confirm dialog ----

function ToastStack({ toasts }: { toasts: Toast[] }) {
  if (typeof document === 'undefined' || toasts.length === 0) return null;
  return createPortal(
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
      ))}
    </div>,
    document.body,
  );
}

function ConfirmDialog({ request, onResolve }: { request: ConfirmRequest | null; onResolve: (v: boolean) => void }) {
  if (typeof document === 'undefined' || !request) return null;
  return createPortal(
    <div className="modal-backdrop confirm-backdrop" onClick={() => onResolve(false)}>
      <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
        <h3>{request.title}</h3>
        <p>{request.message}</p>
        <div className="actions confirm-actions">
          <button className="btn-secondary" onClick={() => onResolve(false)}>Отмена</button>
          <button className={request.danger ? 'btn-danger' : 'btn'} onClick={() => onResolve(true)}>Подтвердить</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PromptDialog({ request, onResolve }: { request: PromptRequest | null; onResolve: (v: string | null) => void }) {
  const [value, setValue] = useState('');
  useEffect(() => { setValue(request?.initial ?? ''); }, [request]);
  if (typeof document === 'undefined' || !request) return null;
  return createPortal(
    <div className="modal-backdrop confirm-backdrop" onClick={() => onResolve(null)}>
      <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
        <h3>{request.title}</h3>
        <p>{request.message}</p>
        <input className="input" autoFocus value={value} placeholder={request.placeholder || ''}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onResolve(value); if (e.key === 'Escape') onResolve(null); }} />
        <div className="actions confirm-actions">
          <button className="btn-secondary" onClick={() => onResolve(null)}>Отмена</button>
          <button className="btn" onClick={() => onResolve(value)}>Сохранить</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---- login ----

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);

    try {
      const data = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      });

      localStorage.setItem('token', data.access_token);
      onLogin();
    } catch {
      setError('Неверный логин или пароль');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark"></div>
        <h1>Eclipse Monitoring</h1>
        <p>Мониторинг узлов инфраструктуры в реальном времени.</p>

        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoFocus />

        <div style={{ height: 10 }} />

        <input
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль"
          type="password"
        />

        {error && <div className="error">{error}</div>}

        <div style={{ height: 14 }} />

        <button className="btn" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Вход…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}

// ---- mobile warning ----

function MobileWarning() {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(typeof window !== 'undefined' && localStorage.getItem('mobileWarningDismissed') === '1');
  }, []);

  if (dismissed) return null;

  return (
    <div className="mobile-warning">
      <span>
        Похоже, панель открыта с телефона. Таблицы, графики и модальные окна рассчитаны на широкий экран —
        часть данных может отображаться нестабильно или не помещаться на экран. Для полноценной работы используй десктоп.
      </span>
      <button
        onClick={() => {
          localStorage.setItem('mobileWarningDismissed', '1');
          setDismissed(true);
        }}
      >
        ×
      </button>
    </div>
  );
}

// ---- main ----

export default function Home() {
  const [logged, setLogged] = useState(false);
  const [tab, setTab] = useState<Tab>('nodes');
  const [servers, setServers] = useState<Server[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [feed, setFeed] = useState<AlertEntry[]>([]);
  const [fleetHistory, setFleetHistory] = useState<any[]>([]);
  const [fleetRange, setFleetRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [alertsVisible, setAlertsVisible] = useState(10);
  const [alertsHasMore, setAlertsHasMore] = useState(false);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [detailsServer, setDetailsServer] = useState<Server | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyRange, setHistoryRange] = useState<'30m' | '1h' | '2h'>('1h');
  const [commandLog, setCommandLog] = useState<CommandEntry[]>([]);
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [newCategory, setNewCategory] = useState<Category>('other');
  const [newCountry, setNewCountry] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | Category>('all');
  const [countryFilter, setCountryFilter] = useState<string>('all');
  const [nodeView, setNodeView] = useState<'table' | 'cards' | 'wall'>('table');
  const [groupByCountry, setGroupByCountry] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [createInstall, setCreateInstall] = useState('');
  const [modalInstall, setModalInstall] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all');
  const [menuState, setMenuState] = useState<{ id: string; x: number; y: number; openUp: boolean } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [ackProblems, setAckProblems] = useState(0);
  const [ackIncidents, setAckIncidents] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);
  const [problems, setProblems] = useState<ProblemsData | null>(null);
  const [versions, setVersions] = useState<VersionsData | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentsVisible, setIncidentsVisible] = useState(20);
  const [incidentsHasMore, setIncidentsHasMore] = useState(false);
  const [incidentsFilter, setIncidentsFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [metricsServerId, setMetricsServerId] = useState<string>('');
  const [metricsHistory, setMetricsHistory] = useState<any[]>([]);
  const [metricsRange, setMetricsRange] = useState<'1h' | '6h' | '24h' | '7d' | '30d'>('6h');
  const [agentLogs, setAgentLogs] = useState<{ logs: string | null; at: string | null } | null>(null);

  function pushToast(text: string, kind: Toast['kind'] = 'success') {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }

  function askConfirm(title: string, message: string, danger = false) {
    return new Promise<boolean>((resolve) => {
      setConfirmRequest({ title, message, danger, resolve });
    });
  }

  function resolveConfirm(v: boolean) {
    confirmRequest?.resolve(v);
    setConfirmRequest(null);
  }

  function askPrompt(title: string, message: string, initial = '', placeholder = '') {
    return new Promise<string | null>((resolve) => {
      setPromptRequest({ title, message, initial, placeholder, resolve });
    });
  }

  function resolvePrompt(v: string | null) {
    promptRequest?.resolve(v);
    setPromptRequest(null);
  }

  async function renameServer(server: Server) {
    setMenuState(null);
    const next = await askPrompt('Переименовать ноду', `Новое имя для «${server.name}»:`, server.name, 'Имя ноды');
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed.length < 2) { pushToast('Имя должно быть не короче 2 символов', 'error'); return; }
    if (trimmed === server.name) return;
    try {
      await api(`/api/servers/${server.id}`, { method: 'PUT', body: JSON.stringify({ name: trimmed }) });
      pushToast(`Нода переименована: «${trimmed}»`);
      await load();
    } catch {
      pushToast('Не удалось переименовать ноду', 'error');
    }
  }

  useEffect(() => {
    setLogged(Boolean(token()));
    if (typeof window !== 'undefined') {
      if (!localStorage.getItem('alertsSeenAt')) localStorage.setItem('alertsSeenAt', new Date().toISOString());
      setAckProblems(Number(localStorage.getItem('ackProblems') || 0));
      setAckIncidents(Number(localStorage.getItem('ackIncidents') || 0));
    }
  }, []);

  // Открыли вкладку «Алерты» — считаем всё прочитанным, счётчик обнуляется.
  useEffect(() => {
    if (!logged || tab !== 'alerts') return;
    localStorage.setItem('alertsSeenAt', new Date().toISOString());
    setSummary((prev) => (prev ? { ...prev, alerts_unread: 0 } : prev));
  }, [logged, tab]);

  // Бейджи «Проблемы»/«Инциденты» гасятся при открытии вкладки; всплывают снова только при росте числа.
  useEffect(() => {
    const pt = problems?.total ?? 0;
    setAckProblems((prev) => { const v = (tab === 'problems' || pt < prev) ? pt : prev; if (typeof window !== 'undefined') localStorage.setItem('ackProblems', String(v)); return v; });
  }, [tab, problems?.total]);
  useEffect(() => {
    const oi = summary?.open_incidents ?? 0;
    setAckIncidents((prev) => { const v = (tab === 'incidents' || oi < prev) ? oi : prev; if (typeof window !== 'undefined') localStorage.setItem('ackIncidents', String(v)); return v; });
  }, [tab, summary?.open_incidents]);

  useEffect(() => {
    setModalInstall('');
  }, [detailsServer?.id]);

  async function load() {
    const since = (typeof window !== 'undefined' && localStorage.getItem('alertsSeenAt')) || '';
    const [s, d] = await Promise.all([
      api('/api/servers'),
      api('/api/dashboard/summary' + (since ? `?alertsSince=${encodeURIComponent(since)}` : '')),
    ]);

    setServers(s);
    setSummary(d);

    if (detailsServer) {
      const updated = s.find((x: Server) => x.id === detailsServer.id);
      if (updated) setDetailsServer(updated);
    }
  }

  useEffect(() => {
    if (!logged) return;

    load().catch((e) => setError(String(e.message || e)));

    const t = setInterval(() => {
      load().catch(() => undefined);
    }, 3000);

    return () => clearInterval(t);
  }, [logged, detailsServer?.id]);

  useEffect(() => {
    if (!logged || tab !== 'alerts') return;
    const load = () => api(`/api/alerts?limit=${alertsVisible}`)
      .then((r) => { setAlerts(r.items); setAlertsHasMore(r.hasMore); })
      .catch(() => undefined);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [logged, tab, alertsVisible]);

  // Лента событий на вкладке «Ноды» — последние алерты.
  useEffect(() => {
    if (!logged || tab !== 'nodes') return;
    const l = () => api('/api/alerts?limit=8').then((r) => setFeed(r.items || [])).catch(() => undefined);
    l();
    const t = setInterval(l, 15000);
    return () => clearInterval(t);
  }, [logged, tab]);

  // История трафика по флоту (почасовые агрегаты) — график на вкладке «Ноды».
  useEffect(() => {
    if (!logged || tab !== 'nodes') return;
    const l = () => api(`/api/dashboard/fleet-history?range=${fleetRange}`).then(setFleetHistory).catch(() => setFleetHistory([]));
    l();
    const t = setInterval(l, 60000);
    return () => clearInterval(t);
  }, [logged, tab, fleetRange]);

  useEffect(() => {
    if (!logged || tab !== 'settings') return;
    api('/api/settings').then(setSettings).catch(() => undefined);
  }, [logged, tab]);

  // Ctrl+K / Cmd+K — командная палитра.
  useEffect(() => {
    if (!logged) return;
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [logged]);

  // Problems poll runs always (feeds the rail badge), not just on the tab.
  useEffect(() => {
    if (!logged) return;
    const l = () => api('/api/dashboard/problems').then(setProblems).catch(() => undefined);
    l();
    const t = setInterval(l, 8000);
    return () => clearInterval(t);
  }, [logged]);

  useEffect(() => {
    if (!logged || tab !== 'updates') return;
    const l = () => api('/api/dashboard/versions').then(setVersions).catch(() => undefined);
    l();
    const t = setInterval(l, 10000);
    return () => clearInterval(t);
  }, [logged, tab]);

  useEffect(() => {
    if (!logged || tab !== 'incidents') return;
    const q = incidentsFilter === 'all' ? '' : `&status=${incidentsFilter}`;
    const l = () => api(`/api/dashboard/incidents?limit=${incidentsVisible}${q}`)
      .then((r) => { setIncidents(r.items); setIncidentsHasMore(r.hasMore); })
      .catch(() => undefined);
    l();
    const t = setInterval(l, 12000);
    return () => clearInterval(t);
  }, [logged, tab, incidentsVisible, incidentsFilter]);

  useEffect(() => {
    if (!logged || tab !== 'metrics') return;
    if (!metricsServerId && servers.length) { setMetricsServerId(servers[0].id); return; }
    if (!metricsServerId) return;
    const l = () => api(`/api/servers/${metricsServerId}/metrics/history?range=${metricsRange}`)
      .then(setMetricsHistory)
      .catch(() => setMetricsHistory([]));
    l();
    const t = setInterval(l, 15000);
    return () => clearInterval(t);
  }, [logged, tab, metricsServerId, metricsRange, servers.length]);

  useEffect(() => {
    if (!logged || !detailsServer?.id) { setAgentLogs(null); return; }
    api(`/api/servers/${detailsServer.id}/logs`).then(setAgentLogs).catch(() => setAgentLogs(null));
  }, [logged, detailsServer?.id, detailsServer?.latestMetrics?.timestamp]);

  useEffect(() => {
    if (!logged || !detailsServer?.id) return;

    api(`/api/servers/${detailsServer.id}/metrics/history?range=${historyRange}`)
      .then(setHistory)
      .catch(() => setHistory([]));

    api(`/api/servers/${detailsServer.id}/commands`)
      .then(setCommandLog)
      .catch(() => setCommandLog([]));
  }, [logged, detailsServer?.id, historyRange, detailsServer?.latestMetrics?.timestamp]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    setCreateInstall('');

    try {
      const created = await api('/api/servers', {
        method: 'POST',
        body: JSON.stringify({ name, ip, port: 3406, category: newCategory, country: newCountry || null }),
      });

      setName('');
      setIp('');
      setCreateInstall(created.install_command);
      pushToast(`Сервер «${created.name}» добавлен`);
      await load();
    } catch (e: any) {
      setError('Не удалось создать сервер: ' + e.message);
      pushToast('Не удалось создать сервер', 'error');
    }
  }

  async function dropOnRow(targetId: string) {
    const src = dragId;
    setDragId(null);
    if (!src || src === targetId) return;
    const ids = servers.map((x) => x.id);
    const from = ids.indexOf(src), to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, src);
    const m = new Map(servers.map((p) => [p.id, p]));
    setServers(ids.map((id) => m.get(id)!).filter(Boolean) as Server[]);
    try { await api('/api/servers/order', { method: 'PUT', body: JSON.stringify({ ids }) }); }
    catch { pushToast('Не удалось переместить сервер', 'error'); }
  }

  async function setServerCategory(server: Server, category: Category) {
    try {
      await api(`/api/servers/${server.id}/category`, { method: 'POST', body: JSON.stringify({ category }) });
      pushToast(`Категория «${server.name}» → ${categoryLabel[category]}`);
      await load();
    } catch {
      pushToast('Не удалось изменить категорию', 'error');
    }
  }

  async function setServerCountry(server: Server, country: string) {
    try {
      await api(`/api/servers/${server.id}`, { method: 'PUT', body: JSON.stringify({ country: country || null }) });
      pushToast(`Страна «${server.name}» → ${countryName(country)}`);
      await load();
    } catch {
      pushToast('Не удалось изменить страну', 'error');
    }
  }

  async function regenerate(server: Server) {
    try {
      const r = await api(`/api/servers/${server.id}/regenerate-token`, { method: 'POST' });
      setModalInstall(r.install_command);
      pushToast('Команда установки переиздана');
    } catch {
      pushToast('Не удалось переиздать команду', 'error');
    }
  }

  async function revoke(server: Server) {
    try {
      await api(`/api/servers/${server.id}/revoke-agent`, { method: 'POST' });
      pushToast(`Доступ агента «${server.name}» отозван`);
      await load();
    } catch {
      pushToast('Не удалось отозвать агент', 'error');
    }
  }

  async function del(server: Server) {
    if (!(await askConfirm('Удалить сервер', `Удалить сервер «${server.name}» из панели? Действие необратимо.`, true))) return;

    try {
      await api(`/api/servers/${server.id}`, { method: 'DELETE' });
      if (detailsServer?.id === server.id) setDetailsServer(null);
      pushToast(`Сервер «${server.name}» удалён из панели`);
      await load();
    } catch {
      pushToast('Не удалось удалить сервер', 'error');
    }
  }

  async function sendCommand(server: Server, command: AgentCommand) {
    if (!canCommand(server.status, command)) return;

    if (command === 'delete') {
      const ok = await askConfirm('Удалить агента с ноды', `Отправить команду на удаление агента с ноды «${server.name}»? Действие необратимо — агент удалит себя с сервера.`, true);
      if (!ok) return;
    }
    if (command === 'update') {
      const ok = await askConfirm('Обновить агента', `Отправить команду обновления агента на «${server.name}»? Агент скачает свежую версию (${versions?.agentLatest ?? AGENT_LATEST_VERSION}) и перезапустится.`);
      if (!ok) return;
    }

    setMenuState(null);

    try {
      await api(`/api/servers/${server.id}/command`, { method: 'POST', body: JSON.stringify({ command }) });
      pushToast(`Команда «${commandLabel[command]}» отправлена для «${server.name}» — выполнится в течение ~${server.latestMetrics ? 5 : 10} сек.`);
      if (detailsServer?.id === server.id) {
        api(`/api/servers/${server.id}/commands`).then(setCommandLog).catch(() => undefined);
      }
    } catch {
      pushToast('Не удалось отправить команду', 'error');
    }
  }

  if (!logged) return <Login onLogin={() => setLogged(true)} />;

  const filtered = servers.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (categoryFilter !== 'all' && (s.category || 'other') !== categoryFilter) return false;
    if (countryFilter !== 'all' && (s.country || '') !== countryFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return s.name.toLowerCase().includes(q) || s.ip.includes(q) || countryName(s.country).toLowerCase().includes(q);
    }
    return true;
  });

  const tabLabels: Record<Tab, string> = { nodes: 'Ноды', problems: 'Проблемы', metrics: 'Метрики', incidents: 'Инциденты', alerts: 'Алерты', updates: 'Обновления', settings: 'Настройки' };
  const tabHints: Record<Tab, string> = {
    nodes: 'мониторинг узлов, нагрузки и трафика',
    problems: 'всё, что требует внимания прямо сейчас',
    metrics: 'история показателей по ноде',
    incidents: 'от сбоя до восстановления',
    alerts: 'история уведомлений',
    updates: 'версии панели и агентов',
    settings: 'пороги, Telegram, безопасность',
  };
  const tabLabel = tabLabels[tab];
  const tabHint = tabHints[tab];
  const health = (summary?.offline ?? 0) > 0 ? 'crit' : (summary?.warning ?? 0) > 0 || (summary?.paused ?? 0) > 0 ? 'warn' : 'good';

  const countryCounts = new Map<string, number>();
  servers.forEach((s) => countryCounts.set(s.country || '', (countryCounts.get(s.country || '') || 0) + 1));
  const usedCountries = Array.from(countryCounts.keys()).filter((c) => c).sort((a, b) => (countryCounts.get(b)! - countryCounts.get(a)!));

  return (
    <main className="app-shell">
      <Head>
        <title>Eclipse Monitoring</title>
        <link rel="icon" href="/icon.ico" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Inter:wght@600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">E</div>
          <div>
            <div className="brand-name">Eclipse</div>
            <div className="brand-sub">monitoring</div>
          </div>
        </div>

        <SidebarNav
          tab={tab}
          setTab={setTab}
          counts={{
            nodes: { n: summary?.total ?? 0 },
            problems: { n: (problems?.total ?? 0) > ackProblems ? (problems?.total ?? 0) : 0, tone: 'crit' },
            incidents: { n: (summary?.open_incidents ?? 0) > ackIncidents ? (summary?.open_incidents ?? 0) : 0, tone: 'warn' },
            alerts: { n: summary?.alerts_unread ?? summary?.alerts_24h ?? 0 },
            updates: { n: problems?.outdatedAgents.length ?? 0, tone: 'warn' },
          }}
        />

        <div className="side-foot">
          <div className="fleet-pill" title="Состояние флота">
            <span className={`pulse-dot ${health === 'crit' ? 'crit' : health === 'warn' ? 'warn' : ''}`} />
            <div className="fleet-txt">
              <b>{summary?.online ?? 0} / {summary?.total ?? 0} онлайн</b>
              сбор метрик активен
            </div>
          </div>

          <button className="user-row" onClick={() => { localStorage.removeItem('token'); location.reload(); }}>
            <span className="avatar">АД</span>
            <span>
              <span className="u-name">admin</span>
              <span className="u-sub">выйти</span>
            </span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="crumb">{tabLabel}<span>{tabHint}</span></div>

          <nav className="mobile-nav">
            <NavButtons tab={tab} setTab={setTab} problemsTotal={(problems?.total ?? 0) > ackProblems ? (problems?.total ?? 0) : 0} alerts24h={summary?.alerts_unread ?? summary?.alerts_24h ?? 0} openIncidents={(summary?.open_incidents ?? 0) > ackIncidents ? (summary?.open_incidents ?? 0) : 0} outdated={problems?.outdatedAgents.length ?? 0} />
          </nav>

          <div className="topbar-right">
            {tab === 'nodes' && (
              <div className="topbar-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><circle cx={11} cy={11} r={6.5} /><path d="m16 16 4.5 4.5" /></svg>
                <input placeholder="Поиск по имени, IP, стране…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            )}
            <button className="topbar-kbd" onClick={() => setCmdkOpen(true)} title="Командная палитра">
              <span className="kbd">Ctrl</span><span className="kbd">K</span>
            </button>
            <span className="session-label">{summary?.online ?? 0}/{summary?.total ?? 0} онлайн</span>
          </div>
        </header>

        <div className="content-area">
          <div className="content-inner">
            <MobileWarning />

            {tab === 'nodes' && (<>
            <section className="kpi-row">
              <KpiCard
                accent="green"
                label="Ноды онлайн"
                value={<>{summary?.online ?? 0}<small> / {summary?.total ?? 0}</small></>}
                sub={`${summary?.waiting ?? 0} ждут агента · ${summary?.paused ?? 0} на паузе`}
                icon={<NodesIcon />}
              />
              <KpiCard
                accent="blue"
                label="Здоровье флота"
                value={<>{summary?.average_health != null ? Math.round(summary.average_health) : '—'}<small> / 100</small></>}
                sub={`средняя нагрузка ${pct(summary?.average_load)}`}
                icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round"><path d="M12 3v18M5 10l7-7 7 7" /></svg>}
              />
              <KpiCard
                accent="amber"
                label="Трафик сейчас"
                value={<>{bps((summary?.total_inbound_bps ?? 0) + (summary?.total_outbound_bps ?? 0))}</>}
                sub={`↓ ${bps(summary?.total_inbound_bps)} · ↑ ${bps(summary?.total_outbound_bps)}`}
                icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M4 16 9 9l4 4 7-9" /></svg>}
              />
              <KpiCard
                accent="red"
                label="Требуют внимания"
                value={<>{problems?.total ?? 0}<small> {(problems?.total ?? 0) === 1 ? 'проблема' : 'проблем'}</small></>}
                sub={`${summary?.open_incidents ?? 0} инцидентов открыто · ${summary?.offline ?? 0} оффлайн`}
                icon={<ProblemsIcon />}
              />
            </section>

            <section className="strip">
              <div className="strip-cell"><div className="l">Средняя CPU</div><div className="v">{pct(summary?.average_cpu)}</div></div>
              <div className="strip-cell"><div className="l">Средняя RAM</div><div className="v">{pct(summary?.average_ram)}</div></div>
              <div className="strip-cell"><div className="l">Подключения</div><div className="v">{summary?.total_connections ?? 0}</div></div>
              <div className="strip-cell"><div className="l">Передано всего</div><div className="v">{bytes(summary?.total_transferred_bytes)}</div></div>
              <div className="strip-cell"><div className="l">ОЗУ во флоте</div><div className="v">{bytes(summary?.total_ram_bytes)}</div></div>
              <div className="strip-cell"><div className="l">Алертов за 24ч</div><div className="v">{summary?.alerts_24h ?? 0}</div></div>
            </section>

            <div className="two-col">
              <section className="panel map-panel">
                <div className="panel-head">
                  <span className="panel-ico">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx={12} cy={12} r={8.5} /><path d="M3.5 12h17M12 3.5c4 4.5 4 12.5 0 17M12 3.5c-4 4.5-4 12.5 0 17" /></svg>
                  </span>
                  <div>
                    <div className="panel-title">Карта флота</div>
                    <div className="panel-subtitle">
                      {servers.filter((s) => s.country).length} нод с указанной страной · {usedCountries.length} стран · размер точки = число нод
                    </div>
                  </div>
                </div>
                <FleetMap servers={servers} onPickCountry={(cc) => setCountryFilter(cc)} />
                <div className="map-legend">
                  <span><i style={{ background: 'var(--accent)' }} />онлайн</span>
                  <span><i style={{ background: 'var(--amber)' }} />предупреждение</span>
                  <span><i style={{ background: 'var(--red)' }} />оффлайн</span>
                  <span style={{ opacity: 0.7 }}>колесо — зум, перетаскивание — сдвиг</span>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <span className="panel-ico blue">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round"><path d="M4 19V5M4 19h16M8 16v-5M13 16V8M18 16v-3" /></svg>
                  </span>
                  <div>
                    <div className="panel-title">География</div>
                    <div className="panel-subtitle">доля трафика по странам</div>
                  </div>
                </div>
                <GeoPanel servers={servers} onPickCountry={(cc) => setCountryFilter(cc)} />
              </section>
            </div>

            <section className="panel">
              <div className="panel-head">
                <span className="panel-ico amber">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M4 16 9 9l4 4 7-9" /></svg>
                </span>
                <div>
                  <div className="panel-title">Трафик флота</div>
                  <div className="panel-subtitle">суммарно по всем нодам, почасовые агрегаты</div>
                </div>
                <div className="range-switch" style={{ marginLeft: 'auto' }}>
                  {(['24h', '7d', '30d'] as const).map((r) => (
                    <button key={r} className={`range-btn ${fleetRange === r ? 'active' : ''}`} onClick={() => setFleetRange(r)}>{r}</button>
                  ))}
                </div>
              </div>
              {fleetHistory.length === 0 ? (
                <div className="chart-empty">Агрегаты за этот период ещё не накопились.</div>
              ) : (
                <div className="charts-grid">
                  <MiniChart title="Трафик флота" data={fleetHistory} unit="bps" spanDays
                    series={[
                      { key: 'inbound_bps', color: 'var(--series-net-in)', label: 'Входящий' },
                      { key: 'outbound_bps', color: 'var(--series-net-out)', label: 'Исходящий' },
                    ]} />
                  <MiniChart title="Подключения" data={fleetHistory} unit="count" spanDays
                    series={[{ key: 'total_connections', color: 'var(--series-ram)', label: 'Соединения' }]} />
                </div>
              )}
            </section>

            <div className="two-col">
              <section className="panel">
                <div className="panel-head">
                  <span className="panel-ico amber">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M4 16 9 9l4 4 7-9" /></svg>
                  </span>
                  <div>
                    <div className="panel-title">Топ нод по нагрузке</div>
                    <div className="panel-subtitle">CPU + RAM по онлайн-нодам</div>
                  </div>
                </div>
                <TopLoad servers={servers} onOpen={setDetailsServer} />
              </section>

              <section className="panel">
                <div className="panel-head">
                  <span className="panel-ico red"><AlertsIcon /></span>
                  <div>
                    <div className="panel-title">Лента событий</div>
                    <div className="panel-subtitle">последние алерты</div>
                  </div>
                  <span className="live-chip" style={{ marginLeft: 'auto' }}><i />LIVE</span>
                </div>
                <FeedPanel alerts={feed} servers={servers} />
              </section>
            </div>
            </>)}

            {tab === 'nodes' && (
          <section className="card panel full-width-panel" id="servers-panel">
            <div className="panel-head">
              <span className="panel-ico"><NodesIcon /></span>
              <div>
                <div className="panel-title">Серверы</div>
                <div className="panel-subtitle">
                  {filtered.length} из {servers.length} нод{countryFilter !== 'all' ? ` · ${countryName(countryFilter)}` : ''}
                </div>
              </div>

              <div className="category-tabs" style={{ marginLeft: 'auto', margin: '0 0 0 auto' }}>
                {CATEGORY_FILTERS.map((c) => (
                  <button key={c.key} className={`cat-tab ${categoryFilter === c.key ? 'active' : ''}`} onClick={() => setCategoryFilter(c.key)}>
                    {c.label}
                    <span className="cat-count">{c.key === 'all' ? servers.length : servers.filter((s) => (s.category || 'other') === c.key).length}</span>
                  </button>
                ))}
              </div>

              <div className="seg">
                <button className={nodeView === 'table' ? 'active' : ''} onClick={() => setNodeView('table')} title="Таблица">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><rect x={3} y={4} width={18} height={16} rx={2} /><path d="M3 10h18M9 10v10" /></svg>
                </button>
                <button className={nodeView === 'cards' ? 'active' : ''} onClick={() => setNodeView('cards')} title="Карточки">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><rect x={3} y={3} width={8} height={8} rx={2} /><rect x={13} y={3} width={8} height={8} rx={2} /><rect x={3} y={13} width={8} height={8} rx={2} /><rect x={13} y={13} width={8} height={8} rx={2} /></svg>
                </button>
                <button className={nodeView === 'wall' ? 'active' : ''} onClick={() => setNodeView('wall')} title="Стена нод">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><rect x={3} y={3} width={5.2} height={5.2} rx={1.4} /><rect x={9.4} y={3} width={5.2} height={5.2} rx={1.4} /><rect x={15.8} y={3} width={5.2} height={5.2} rx={1.4} /><rect x={3} y={9.4} width={5.2} height={5.2} rx={1.4} /><rect x={9.4} y={9.4} width={5.2} height={5.2} rx={1.4} /><rect x={15.8} y={9.4} width={5.2} height={5.2} rx={1.4} /><rect x={3} y={15.8} width={5.2} height={5.2} rx={1.4} /><rect x={9.4} y={15.8} width={5.2} height={5.2} rx={1.4} /><rect x={15.8} y={15.8} width={5.2} height={5.2} rx={1.4} /></svg>
                </button>
              </div>
            </div>

            <form className="form-grid" onSubmit={create}>
              <input className="input" placeholder="Название сервера" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="input" placeholder="IP-адрес" value={ip} onChange={(e) => setIp(e.target.value)} />
              <CountrySelect value={newCountry} onChange={setNewCountry} title="Страна ноды (флаг в списке)" />
              <select className="input" value={newCategory} onChange={(e) => setNewCategory(e.target.value as Category)} title="Категория ноды">
                {(Object.keys(categoryLabel) as Category[]).map((c) => <option key={c} value={c}>{categoryLabel[c]}</option>)}
              </select>
              <button className="btn">Добавить сервер</button>
            </form>

            {error && <div className="error">{error}</div>}

            {createInstall && (
              <div className="install-box">
                <h3>Команда установки агента</h3>
                <pre className="raw-box">{createInstall}</pre>
              </div>
            )}

            {usedCountries.length > 0 && (
              <div className="filter-row">
                <div className="cc-chips">
                  <button className={`cc-chip ${countryFilter === 'all' ? 'active' : ''}`} onClick={() => setCountryFilter('all')}>
                    Все страны <span className="n">{servers.length}</span>
                  </button>
                  {usedCountries.map((cc) => (
                    <button key={cc} className={`cc-chip ${countryFilter === cc ? 'active' : ''}`} onClick={() => setCountryFilter(cc)}>
                      <Flag cc={cc} size="sm" />{COUNTRY_NAME[cc] || cc}<span className="n">{countryCounts.get(cc)}</span>
                    </button>
                  ))}
                  {(countryCounts.get('') ?? 0) > 0 && (
                    <button className={`cc-chip ${countryFilter === '' ? 'active' : ''}`} onClick={() => setCountryFilter('')}>
                      Без страны <span className="n">{countryCounts.get('')}</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="filter-row">
              <input className="input filter-search" placeholder="Поиск по имени, IP или стране…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select className="input filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
                <option value="all">Все статусы</option>
                {Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <label className="toggle-row" style={{ marginTop: 0 }}>
                <input type="checkbox" checked={groupByCountry} onChange={(e) => setGroupByCountry(e.target.checked)} />
                <span>Группировать по стране</span>
              </label>
            </div>

            {nodeView === 'cards' && (
              <div className="node-cards" style={{ padding: 0 }}>
                {filtered.length === 0 && <span className="muted">Ничего не найдено по текущему фильтру.</span>}
                {filtered.map((s) => (
                  <div className="ncard" key={s.id} onClick={() => setDetailsServer(s)}>
                    <div className="ncard-head">
                      <Flag cc={s.country} />
                      <div className="node-meta" style={{ flex: 1 }}>
                        <div className="server-name">{s.name}<span className={`cat-badge cat-${s.category || 'other'}`}>{categoryLabel[(s.category || 'other') as Category]}</span></div>
                        <div className="node-id">{s.ip} · {countryName(s.country)}</div>
                      </div>
                      <HealthRing health={s.health} />
                    </div>
                    <div className="ncard-metrics">
                      <div><div className="l">CPU</div><SmallMeter value={s.latestMetrics?.cpu_usage_percent} /></div>
                      <div><div className="l">RAM</div><SmallMeter value={s.latestMetrics?.memory_usage_percent} /></div>
                      <div><div className="l">Диск</div><SmallMeter value={s.latestMetrics?.disk_usage_percent} /></div>
                    </div>
                    <div className="ncard-foot">
                      <span className={`badge ${s.status}`}><span className="dot" />{statusLabel[s.status]}</span>
                      {s.latestMetrics
                        ? <span className="traffic-cell"><span className="dn">↓{bps(s.latestMetrics.inbound_bps)}</span> <span className="up">↑{bps(s.latestMetrics.outbound_bps)}</span></span>
                        : <span className="muted">нет метрик</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {nodeView === 'wall' && (
              <div className="wall" style={{ padding: 0 }}>
                {filtered.length === 0 && <span className="muted">Ничего не найдено по текущему фильтру.</span>}
                {filtered.map((s) => {
                  const score = s.health?.score ?? 0;
                  const tone = !s.health || s.status === 'offline' ? 'n' : score >= 85 ? '' : score >= 60 ? 'w' : 'c';
                  return (
                    <div className={`wall-tile ${tone}`} key={s.id} onClick={() => setDetailsServer(s)} title={`${s.name} · ${countryName(s.country)}`}>
                      <div className="wall-fill" style={{ height: `${score || 6}%` }} />
                      <div className="wall-top">
                        <Flag cc={s.country} size="sm" />
                        <span className={`cat-badge cat-${s.category || 'other'}`}>{categoryLabel[(s.category || 'other') as Category]}</span>
                        <span className={`wall-st ${s.status}`} />
                      </div>
                      <div className="wall-name">{s.name}</div>
                      <div className="wall-h">{s.health ? score : '—'}<small> health</small></div>
                      <div className="wall-sub">
                        <span>cpu {s.latestMetrics?.cpu_usage_percent != null ? Math.round(s.latestMetrics.cpu_usage_percent) : '—'}</span>
                        <span>ram {s.latestMetrics?.memory_usage_percent != null ? Math.round(s.latestMetrics.memory_usage_percent) : '—'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="table-wrap" style={{ display: nodeView === 'table' ? undefined : 'none' }}>
              <table>
                <thead>
                  <tr>
                    <th className="drag-col"></th>
                    <th>Сервер</th>
                    <th>IP</th>
                    <th>Статус</th>
                    <th>Здоровье</th>
                    <th>CPU</th>
                    <th>RAM</th>
                    <th>Диск</th>
                    <th>Трафик сейчас</th>
                    <th>Подключения</th>
                    <th>Последняя метрика</th>
                    <th></th>
                  </tr>
                </thead>

                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={12} className="muted">
                        {servers.length === 0 ? 'Серверов пока нет. Добавь первый сервер выше.' : 'Ничего не найдено по текущему фильтру.'}
                      </td>
                    </tr>
                  )}

                  {(groupByCountry
                    ? Array.from(new Set(filtered.map((s) => s.country || ''))).flatMap((cc) => {
                        const group = filtered.filter((s) => (s.country || '') === cc);
                        return [{ groupOf: cc, count: group.length, online: group.filter((s) => s.status === 'online').length } as const, ...group];
                      })
                    : filtered
                  ).map((entry: any) => entry.groupOf !== undefined ? (
                    <tr className="group-row" key={`g-${entry.groupOf || 'none'}`}>
                      <td colSpan={12}>
                        <div className="group-label">
                          <Flag cc={entry.groupOf} size="sm" />
                          {countryName(entry.groupOf)}
                          <span className="n">{entry.count} нод · {entry.online} онлайн</span>
                        </div>
                      </td>
                    </tr>
                  ) : (() => { const s: Server = entry; return (
                    <tr
                      key={s.id}
                      className={`${dragId === s.id ? 'row-dragging' : ''} row-${s.status}`}
                      onDragOver={(e) => { if (dragId) e.preventDefault(); }}
                      onDrop={(e) => { e.preventDefault(); dropOnRow(s.id); }}
                    >
                      <td className="drag-col">
                        <span
                          className="drag-handle"
                          draggable={!groupByCountry}
                          onDragStart={(e) => { if (groupByCountry) { e.preventDefault(); return; } setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; }}
                          onDragEnd={() => setDragId(null)}
                          title={groupByCountry ? 'Сортировка недоступна при группировке' : 'Перетащить для сортировки'}
                        >⠿</span>
                      </td>
                      <td>
                        <div className="node-cell">
                          <Flag cc={s.country} />
                          <div className="node-meta">
                            <div className="server-name">{s.name} <span className={`cat-badge cat-${s.category || 'other'}`}>{categoryLabel[(s.category || 'other') as Category]}</span></div>
                            <div className="node-id">{countryName(s.country)}{s.agent_version ? ` · v${s.agent_version}` : ''}</div>
                            {s.agent_stale && <div className="stale-chip">агент молчит {ago(s.last_seen_at)}</div>}
                          </div>
                        </div>
                      </td>

                      <td className="mono muted">{s.ip}</td>

                      <td>
                        <span className={`badge ${s.status}`}>
                          <span className="dot" />
                          {statusLabel[s.status]}
                        </span>
                      </td>

                      <td><HealthRing health={s.health} /></td>

                      <td><SmallMeter value={s.latestMetrics?.cpu_usage_percent} /></td>
                      <td><SmallMeter value={s.latestMetrics?.memory_usage_percent} /></td>
                      <td><SmallMeter value={s.latestMetrics?.disk_usage_percent} /></td>

                      <td>
                        {s.latestMetrics ? (
                          <div className="traffic-cell">
                            <div className="dn">↓ {bps(s.latestMetrics?.inbound_bps)}</div>
                            <div className="up">↑ {bps(s.latestMetrics?.outbound_bps)}</div>
                          </div>
                        ) : <span className="muted">—</span>}
                      </td>

                      <td className="mono">{s.latestMetrics?.total_connections ?? '—'}</td>

                      <td className="muted">{s.status === 'offline' ? `оффлайн, ${ago(s.last_seen_at)}` : when(s.last_seen_at)}</td>

                      <td>
                        <div className="row-actions">
                          <button className="btn-secondary" onClick={() => setDetailsServer(s)}>Подробнее</button>
                          <button
                            className="btn-secondary icon-btn"
                            onClick={(e) => {
                              if (menuState?.id === s.id) { setMenuState(null); return; }
                              const rect = e.currentTarget.getBoundingClientRect();
                              const openUp = rect.bottom + 190 > window.innerHeight;
                              setMenuState({ id: s.id, x: rect.right, y: openUp ? rect.top - 6 : rect.bottom + 6, openUp });
                            }}
                          >
                            ⋮
                          </button>
                        </div>
                      </td>
                    </tr>
                  ); })())}
                </tbody>
              </table>
            </div>
          </section>
        )}

            {tab === 'problems' && <ProblemsView problems={problems} servers={servers} onOpenServer={(id) => { const s = servers.find((x) => x.id === id); if (s) setDetailsServer(s); }} onSendCommand={sendCommand} />}
            {tab === 'metrics' && <MetricsView servers={servers} serverId={metricsServerId} setServerId={setMetricsServerId} range={metricsRange} setRange={setMetricsRange} history={metricsHistory} />}
            {tab === 'incidents' && <IncidentsView servers={servers} incidents={incidents} hasMore={incidentsHasMore} onShowMore={() => setIncidentsVisible((v) => v + 20)} filter={incidentsFilter} setFilter={setIncidentsFilter} />}
            {tab === 'updates' && <UpdatesView versions={versions} servers={servers} onSendCommand={sendCommand} pushToast={pushToast} askConfirm={askConfirm} />}
            {tab === 'alerts' && <AlertsView alerts={alerts} servers={servers} hasMore={alertsHasMore} onShowMore={() => setAlertsVisible((v) => v + 10)} />}
            {tab === 'settings' && <SettingsView settings={settings} onChange={setSettings} pushToast={pushToast} askConfirm={askConfirm} />}
          </div>
        </div>

        <footer className="app-footer">
          <div>Eclipse Monitoring</div>
          <div className="pulse">Сбор метрик активен</div>
        </footer>
      </div>

      {menuState && (() => {
        const s = servers.find((x) => x.id === menuState.id);
        if (!s) return null;
        return createPortal(
          <>
            <div className="menu-overlay" onClick={() => setMenuState(null)} />
            <div
              className="menu"
              style={{ position: 'fixed', left: menuState.x, top: menuState.y, transform: `translate(-100%, ${menuState.openUp ? '-100%' : '0'})` }}
            >
              <button onClick={() => renameServer(s)}>✎ Переименовать</button>
              <button disabled={!canCommand(s.status, 'start')} onClick={() => sendCommand(s, 'start')}>▶ Запустить</button>
              <button disabled={!canCommand(s.status, 'stop')} onClick={() => sendCommand(s, 'stop')}>⏸ Остановить</button>
              <button disabled={!canCommand(s.status, 'restart')} onClick={() => sendCommand(s, 'restart')}>⟳ Перезапустить</button>
              <button className="danger" disabled={!canCommand(s.status, 'delete')} onClick={() => sendCommand(s, 'delete')}>✕ Удалить агента с ноды</button>
            </div>
          </>,
          document.body,
        );
      })()}

      {detailsServer && (
        <DetailsModal
          server={detailsServer}
          history={history}
          historyRange={historyRange}
          onRangeChange={setHistoryRange}
          commandLog={commandLog}
          install={modalInstall}
          agentLogs={agentLogs}
          onSetCategory={(c) => setServerCategory(detailsServer, c)}
          onSetCountry={(c) => setServerCountry(detailsServer, c)}
          onClose={() => setDetailsServer(null)}
          onRename={() => renameServer(detailsServer)}
          onRegenerate={() => regenerate(detailsServer)}
          onRevoke={() => revoke(detailsServer)}
          onDelete={() => del(detailsServer)}
          onCommand={(c) => sendCommand(detailsServer, c)}
        />
      )}

      {cmdkOpen && (
        <CommandPalette
          servers={servers}
          onClose={() => setCmdkOpen(false)}
          onPickServer={(s) => { setTab('nodes'); setDetailsServer(s); }}
          onPickTab={(t) => setTab(t)}
        />
      )}

      <ToastStack toasts={toasts} />
      <ConfirmDialog request={confirmRequest} onResolve={resolveConfirm} />
      <PromptDialog request={promptRequest} onResolve={resolvePrompt} />
    </main>
  );
}

function KpiCard({ accent, label, value, sub, icon }: {
  accent: 'green' | 'blue' | 'amber' | 'red';
  label: string;
  value: ReactNode;
  sub: string;
  icon: ReactNode;
}) {
  return (
    <div className={`kpi a-${accent}`}>
      <div className="kpi-top">
        <span className="kpi-ico">{icon}</span>
        {label}
      </div>
      <div className="kpi-val">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

function TopLoad({ servers, onOpen }: { servers: Server[]; onOpen: (s: Server) => void }) {
  const rows = servers
    .filter((s) => s.latestMetrics && (s.status === 'online' || s.status === 'warning'))
    .map((s) => ({
      s,
      load: ((s.latestMetrics?.cpu_usage_percent || 0) + (s.latestMetrics?.memory_usage_percent || 0)) / 2,
    }))
    .sort((a, b) => b.load - a.load)
    .slice(0, 6);

  if (rows.length === 0) return <div className="geo-list"><span className="muted">Нет онлайн-нод с метриками.</span></div>;

  return (
    <div className="geo-list">
      {rows.map(({ s, load }) => (
        <div className="geo-row" key={s.id} onClick={() => onOpen(s)}>
          <Flag cc={s.country} />
          <div style={{ width: 140, minWidth: 0 }}>
            <div className="geo-name">{s.name}</div>
            <div className="geo-meta">cpu {pct(s.latestMetrics?.cpu_usage_percent)} · ram {pct(s.latestMetrics?.memory_usage_percent)}</div>
          </div>
          <div className="geo-bar">
            <i style={{
              width: `${barWidth(load)}%`,
              background: load >= 80 ? 'var(--red)' : load >= 65 ? 'var(--amber)' : undefined,
            }} />
          </div>
          <div className="geo-val">{pct(load)}</div>
        </div>
      ))}
    </div>
  );
}

function FeedPanel({ alerts, servers }: { alerts: AlertEntry[]; servers: Server[] }) {
  if (alerts.length === 0) return <div className="feed"><span className="muted">Событий пока нет — всё спокойно.</span></div>;
  return (
    <div className="feed">
      {alerts.map((a) => {
        const srv = servers.find((s) => s.id === a.server_id);
        return (
          <div className="feed-item" key={a.id}>
            <span className={`feed-dot ${a.level}`} />
            <Flag cc={srv?.country} size="sm" />
            <div className="feed-txt">
              <b>{a.server_name}</b> <span>·</span> {kindLabel(a.kind)} <span>— {a.message}</span>
            </div>
            <span className="feed-time">{new Date(a.created_at).toLocaleTimeString('ru-RU')}</span>
          </div>
        );
      })}
    </div>
  );
}

function CommandPalette({ servers, onClose, onPickServer, onPickTab }: {
  servers: Server[];
  onClose: () => void;
  onPickServer: (s: Server) => void;
  onPickTab: (t: Tab) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  const tabRows: { key: Tab; label: string }[] = [
    { key: 'nodes', label: 'Перейти: Ноды' },
    { key: 'problems', label: 'Перейти: Проблемы' },
    { key: 'metrics', label: 'Перейти: Метрики' },
    { key: 'incidents', label: 'Перейти: Инциденты' },
    { key: 'alerts', label: 'Перейти: Алерты' },
    { key: 'updates', label: 'Перейти: Обновления' },
    { key: 'settings', label: 'Перейти: Настройки' },
  ];

  const query = q.toLowerCase().trim();
  const nodeHits = servers
    .filter((s) => !query || s.name.toLowerCase().includes(query) || s.ip.includes(query) || countryName(s.country).toLowerCase().includes(query))
    .slice(0, 6);
  const tabHits = tabRows.filter((t) => !query || t.label.toLowerCase().includes(query)).slice(0, 5);
  const rows: ({ kind: 'node'; s: Server } | { kind: 'tab'; t: Tab; label: string })[] = [
    ...nodeHits.map((s) => ({ kind: 'node' as const, s })),
    ...tabHits.map((t) => ({ kind: 'tab' as const, t: t.key, label: t.label })),
  ];

  function run(i: number) {
    const r = rows[i];
    if (!r) return;
    onClose();
    if (r.kind === 'node') onPickServer(r.s); else onPickTab(r.t);
  }

  useEffect(() => { setSel(0); }, [q]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((v) => (rows.length ? (v + 1) % rows.length : 0)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((v) => (rows.length ? (v - 1 + rows.length) % rows.length : 0)); }
      if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (typeof document === 'undefined') return null;

  let lastKind = '';
  return createPortal(
    <div className="cmdk-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk">
        <div className="cmdk-in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><circle cx={11} cy={11} r={6.5} /><path d="m16 16 4.5 4.5" /></svg>
          <input autoFocus placeholder="Нода, IP, страна или раздел…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="cmdk-list">
          {rows.length === 0 && <div className="cmdk-sec">Ничего не найдено</div>}
          {rows.map((r, i) => {
            const header = r.kind !== lastKind ? (lastKind = r.kind, r.kind === 'node' ? 'Ноды' : 'Разделы') : null;
            return (
              <div key={r.kind === 'node' ? r.s.id : r.t}>
                {header && <div className="cmdk-sec">{header}</div>}
                <div className={`cmdk-row ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(i)}>
                  {r.kind === 'node' ? (
                    <>
                      <Flag cc={r.s.country} size="sm" />
                      <b>{r.s.name}</b>
                      <span className="s">{r.s.ip} · {statusLabel[r.s.status]}</span>
                    </>
                  ) : (
                    <>
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                      {r.label}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="cmdk-foot">
          <span><span className="kbd">↑↓</span> навигация</span>
          <span><span className="kbd">↵</span> открыть</span>
          <span><span className="kbd">esc</span> закрыть</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SummaryCard({ label, value, sub, tone }: { label: string; value: string | number; sub: string; tone?: 'good' | 'warning' | 'critical' | 'info' }) {
  return (
    <div className={`card summary-card ${tone ? `tone-${tone}` : ''}`}>
      <div className="summary-label">{label}</div>
      <div className="summary-value">{value}</div>
      <div className="summary-sub">{sub}</div>
    </div>
  );
}

function SmallMeter({ value }: { value?: number | null }) {
  if (value === undefined || value === null) return <span className="muted">—</span>;
  return (
    <div className="metric-mini">
      <span>{pct(value)}</span>
      <div className="bar">
        <span style={{ width: `${barWidth(value)}%` }} />
      </div>
    </div>
  );
}

function AlertsView({ alerts, hasMore, onShowMore, servers }: { alerts: AlertEntry[]; hasMore: boolean; onShowMore: () => void; servers: Server[] }) {
  return (
    <section className="card panel full-width-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Алерты</div>
          <div className="panel-subtitle">История уведомлений по CPU, RAM, диску, трафику и доступности нод</div>
        </div>
      </div>

      {alerts.length === 0 && <div className="muted">Алертов пока нет.</div>}

      <div className="alert-list">
        {alerts.map((a) => (
          <div key={a.id} className={`alert-row level-${a.level}`}>
            <span className="alert-dot" />
            <Flag cc={servers.find((s) => s.id === a.server_id)?.country} size="sm" />
            <div className="alert-body">
              <div className="alert-title">
                <strong>{a.server_name}</strong>
                <span className="muted"> · {kindLabel(a.kind)}</span>
              </div>
              <div className="alert-message">{a.message}</div>
            </div>
            <div className="muted alert-time">{when(a.created_at)}</div>
          </div>
        ))}
      </div>

      {hasMore && (
        <div className="show-more-row">
          <button className="btn-secondary" onClick={onShowMore}>Показать ещё</button>
        </div>
      )}
    </section>
  );
}

function SettingsView({
  settings,
  onChange,
  pushToast,
  askConfirm,
}: {
  settings: SettingsData | null;
  onChange: (s: SettingsData) => void;
  pushToast: (text: string, kind?: Toast['kind']) => void;
  askConfirm: (title: string, message: string, danger?: boolean) => Promise<boolean>;
}) {
  const [tokenInput, setTokenInput] = useState('');
  const [chatIdInput, setChatIdInput] = useState('');
  const [panicCats, setPanicCats] = useState<Category[]>([]);
  const [panicBusy, setPanicBusy] = useState(false);
  const [thresholds, setThresholds] = useState(settings?.thresholds);
  const [vpnMon, setVpnMon] = useState<boolean>(settings?.vpnMonitoring ?? true);
  const [bridgeMon, setBridgeMon] = useState<boolean>(settings?.bridgeMonitoring ?? true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (settings) { setThresholds(settings.thresholds); setVpnMon(settings.vpnMonitoring); setBridgeMon(settings.bridgeMonitoring); } }, [settings]);

  async function saveToken(e: FormEvent) {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setBusy(true);
    try {
      const s = await api('/api/settings/telegram/token', { method: 'POST', body: JSON.stringify({ token: tokenInput.trim() }) });
      onChange(s);
      setTokenInput('');
      pushToast('Токен Telegram-бота сохранён');
    } catch {
      pushToast('Не удалось сохранить токен', 'error');
    } finally { setBusy(false); }
  }

  async function clearToken() {
    if (!(await askConfirm('Удалить токен', 'Удалить сохранённый токен Telegram-бота? Уведомления перестанут приходить.', true))) return;
    try {
      const s = await api('/api/settings/telegram/token', { method: 'DELETE' });
      onChange(s);
      pushToast('Токен удалён');
    } catch {
      pushToast('Не удалось удалить токен', 'error');
    }
  }

  async function addChatId(e: FormEvent) {
    e.preventDefault();
    if (!chatIdInput.trim()) return;
    try {
      const s = await api('/api/settings/telegram/chat-ids', { method: 'POST', body: JSON.stringify({ id: chatIdInput.trim() }) });
      onChange(s);
      setChatIdInput('');
      pushToast('Администратор добавлен');
    } catch {
      pushToast('Не удалось добавить ID', 'error');
    }
  }

  async function removeChatId(id: string) {
    try {
      const s = await api(`/api/settings/telegram/chat-ids/${encodeURIComponent(id)}`, { method: 'DELETE' });
      onChange(s);
      pushToast('Администратор удалён');
    } catch {
      pushToast('Не удалось удалить ID', 'error');
    }
  }

  async function saveThresholds() {
    if (!thresholds) return;
    setBusy(true);
    try {
      const s = await api('/api/settings/thresholds', { method: 'PUT', body: JSON.stringify({ ...thresholds, vpnMonitoring: vpnMon, bridgeMonitoring: bridgeMon }) });
      onChange(s);
      pushToast('Пороги алертов обновлены');
    } catch {
      pushToast('Не удалось сохранить пороги', 'error');
    } finally { setBusy(false); }
  }

  async function panic() {
    if (!panicCats.length) { pushToast('Выбери хотя бы одну категорию', 'error'); return; }
    const labels = panicCats.map((c) => categoryLabel[c]).join(', ');
    if (!(await askConfirm('Экстренное выключение', `Выключить ВСЕ сервера категорий: ${labels}? Будут ВЫКЛЮЧЕНЫ сами машины (poweroff, не агент). Поднять обратно — только вручную у провайдера.`, true))) return;
    if (!(await askConfirm('Подтверди ещё раз', 'Это физически выключит выбранные сервера. Действие необратимо из панели.', true))) return;
    setPanicBusy(true);
    try {
      const r = await api('/api/servers/poweroff', { method: 'POST', body: JSON.stringify({ categories: panicCats }) });
      pushToast(`Команда выключения отправлена на ${r.count} сервер(ов)`);
    } catch { pushToast('Не удалось отправить выключение', 'error'); }
    finally { setPanicBusy(false); }
  }

  if (!settings) return <section className="card panel full-width-panel"><div className="muted">Загрузка…</div></section>;

  return (
    <>
    <div className="settings-grid">
      <section className="card panel">
        <div className="panel-title">Telegram-уведомления</div>
        <div className="panel-subtitle">Токен бота хранится в зашифрованном виде и не показывается повторно.</div>

        <div className="settings-block">
          {settings.telegramConfigured ? (
            <div className="telegram-status">
              <span className="badge online"><span className="dot" />Токен настроен</span>
              <button className="btn-secondary" onClick={clearToken}>Удалить токен</button>
            </div>
          ) : (
            <form className="form-grid-2" onSubmit={saveToken}>
              <input className="input" placeholder="Токен бота (от @BotFather)" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} type="password" />
              <button className="btn" disabled={busy}>Сохранить</button>
            </form>
          )}
        </div>

        <div className="settings-block">
          <div className="settings-label">ID администраторов (получают алерты)</div>
          <form className="form-grid-2" onSubmit={addChatId}>
            <input className="input" placeholder="Telegram chat ID, например 123456789" value={chatIdInput} onChange={(e) => setChatIdInput(e.target.value)} />
            <button className="btn-secondary">Добавить</button>
          </form>

          <div className="chip-list">
            {settings.telegramChatIds.length === 0 && <span className="muted">Пока никто не добавлен.</span>}
            {settings.telegramChatIds.map((id) => (
              <span className="chip" key={id}>
                {id}
                <button onClick={() => removeChatId(id)}>×</button>
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="card panel">
        <div className="panel-title">Пороги алертов</div>
        <div className="panel-subtitle">Когда показатель держится выше порога дольше указанного времени — приходит уведомление.</div>

        {thresholds && (
          <div className="threshold-grid">
            <label>CPU, %<input className="input" type="number" min={1} max={100} value={thresholds.cpuPercent} onChange={(e) => setThresholds({ ...thresholds, cpuPercent: Number(e.target.value) })} /></label>
            <label>RAM, %<input className="input" type="number" min={1} max={100} value={thresholds.ramPercent} onChange={(e) => setThresholds({ ...thresholds, ramPercent: Number(e.target.value) })} /></label>
            <label>Диск, %<input className="input" type="number" min={1} max={100} value={thresholds.diskPercent} onChange={(e) => setThresholds({ ...thresholds, diskPercent: Number(e.target.value) })} /></label>
            <label>Длительность, мин<input className="input" type="number" min={1} max={60} value={thresholds.sustainedMinutes} onChange={(e) => setThresholds({ ...thresholds, sustainedMinutes: Number(e.target.value) })} /></label>
            <label>Трафик аномален от, Мбит/с<input className="input" type="number" min={10} max={100000} step={10} value={thresholds.trafficMbps} onChange={(e) => setThresholds({ ...thresholds, trafficMbps: Number(e.target.value) })} /></label>
            <label>Перегрузка моста от, сессий<input className="input" type="number" min={1} max={10000000} step={100} value={thresholds.bridgeSessions} onChange={(e) => setThresholds({ ...thresholds, bridgeSessions: Number(e.target.value) })} /></label>
            <label>Мост недоступен от, мин<input className="input" type="number" min={1} max={59} value={thresholds.bridgeDownMinutes} onChange={(e) => setThresholds({ ...thresholds, bridgeDownMinutes: Number(e.target.value) })} /></label>
          </div>
        )}

        <label className="toggle-row">
          <input type="checkbox" checked={vpnMon} onChange={(e) => setVpnMon(e.target.checked)} />
          <span>VPN-мониторинг (health-штраф и алерт «VPN не работает»). Выключи, если VPN-сервис не используется.</span>
        </label>

        <label className="toggle-row">
          <input type="checkbox" checked={bridgeMon} onChange={(e) => setBridgeMon(e.target.checked)} />
          <span>Мониторинг мостов (алерты «мост недоступен» и «мост перегружен»). Выключи, чтобы полностью отключить уведомления по мостам HAProxy.</span>
        </label>

        <div style={{ height: 12 }} />
        <button className="btn" onClick={saveThresholds} disabled={busy}>Сохранить пороги</button>
      </section>
    </div>

    <section className="card panel full-width-panel panic-panel">
      <div className="panel-title">🔴 Экстренное выключение</div>
      <div className="panel-subtitle">Разом выключает СЕРВЕРА выбранных категорий (poweroff самой машины, агент тут ни при чём). Поднять обратно — только вручную у провайдера. Команда уходит нодам со статусом онлайн/пауза.</div>
      <div className="panic-cats">
        {(Object.keys(categoryLabel) as Category[]).map((c) => (
          <label key={c} className={`panic-chip ${panicCats.includes(c) ? 'on' : ''}`}>
            <input type="checkbox" checked={panicCats.includes(c)} onChange={(e) => setPanicCats((prev) => e.target.checked ? [...prev, c] : prev.filter((x) => x !== c))} />
            {categoryLabel[c]}
          </label>
        ))}
      </div>
      <div style={{ height: 14 }} />
      <button className="btn-danger panic-btn" disabled={panicBusy || !panicCats.length} onClick={panic}>
        {panicBusy ? 'Отправка…' : `ВЫКЛЮЧИТЬ СЕРВЕРА${panicCats.length ? ` · ${panicCats.map((c) => categoryLabel[c]).join(', ')}` : ''}`}
      </button>
    </section>

    <SecurityView pushToast={pushToast} askConfirm={askConfirm} />
    </>
  );
}

function SecurityView({
  pushToast,
  askConfirm,
}: {
  pushToast: (text: string, kind?: Toast['kind']) => void;
  askConfirm: (title: string, message: string, danger?: boolean) => Promise<boolean>;
}) {
  const [log, setLog] = useState<AuthAttempt[]>([]);
  const [logVisible, setLogVisible] = useState(10);
  const [logHasMore, setLogHasMore] = useState(false);
  const [blocked, setBlocked] = useState<BlockedIp[]>([]);
  const [blockInput, setBlockInput] = useState('');

  useEffect(() => {
    api(`/api/security/auth-log?limit=${logVisible}`).then((r) => { setLog(r.items); setLogHasMore(r.hasMore); }).catch(() => undefined);
  }, [logVisible]);

  useEffect(() => {
    api('/api/security/blocked-ips').then(setBlocked).catch(() => undefined);
  }, []);

  async function blockManually(e: FormEvent) {
    e.preventDefault();
    const ip = blockInput.trim();
    if (!ip) return;
    try {
      const rows = await api('/api/security/blocked-ips', { method: 'POST', body: JSON.stringify({ ip, reason: 'Заблокирован вручную из панели' }) });
      setBlocked(rows);
      setBlockInput('');
      pushToast(`IP ${ip} заблокирован`);
    } catch {
      pushToast('Не удалось заблокировать IP', 'error');
    }
  }

  async function unblock(ip: string) {
    if (!(await askConfirm('Разблокировать IP', `Разблокировать ${ip}? Он снова сможет обращаться к панели.`))) return;
    try {
      const rows = await api(`/api/security/blocked-ips/${encodeURIComponent(ip)}`, { method: 'DELETE' });
      setBlocked(rows);
      pushToast(`IP ${ip} разблокирован`);
    } catch {
      pushToast('Не удалось разблокировать IP', 'error');
    }
  }

  return (
    <section className="card panel full-width-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Безопасность</div>
          <div className="panel-subtitle">Журнал входов в панель и заблокированные IP-адреса. Уведомления о входах приходят в Telegram, если настроен бот.</div>
        </div>
      </div>

      <div className="security-grid">
        <div>
          <div className="settings-label">Заблокированные IP</div>
          <form className="form-grid-2" onSubmit={blockManually}>
            <input className="input" placeholder="IP-адрес для блокировки" value={blockInput} onChange={(e) => setBlockInput(e.target.value)} />
            <button className="btn-danger">Заблокировать</button>
          </form>

          <div className="chip-list">
            {blocked.length === 0 && <span className="muted">Заблокированных IP нет.</span>}
            {blocked.map((b) => (
              <span className="chip" key={b.ip} title={`${b.reason || ''} · ${when(b.blocked_at)}`}>
                {b.ip}
                <button onClick={() => unblock(b.ip)}>×</button>
              </span>
            ))}
          </div>
        </div>

        <div>
          <div className="settings-label">Журнал входов</div>
          <div className="auth-log">
            {log.length === 0 && <div className="muted">Попыток входа пока нет.</div>}
            {log.map((a) => (
              <div className={`auth-row ${a.success ? 'ok' : 'fail'}`} key={a.id}>
                <span className="auth-dot" />
                <div className="auth-body">
                  <div>{a.email || '—'} <span className="muted">· {a.ip || '—'}</span></div>
                  <div className="muted auth-ua">{a.user_agent || '—'}</div>
                </div>
                <div className="muted auth-time">{when(a.created_at)}</div>
              </div>
            ))}
          </div>

          {logHasMore && (
            <div className="show-more-row">
              <button className="btn-secondary" onClick={() => setLogVisible((v) => v + 10)}>Показать ещё</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function DetailsModal({
  server,
  history,
  historyRange,
  onRangeChange,
  commandLog,
  install,
  agentLogs,
  onSetCategory,
  onSetCountry,
  onClose,
  onRename,
  onRegenerate,
  onRevoke,
  onDelete,
  onCommand,
}: {
  server: Server;
  history: any[];
  historyRange: '30m' | '1h' | '2h';
  onRangeChange: (r: '30m' | '1h' | '2h') => void;
  commandLog: CommandEntry[];
  install: string;
  agentLogs: { logs: string | null; at: string | null } | null;
  onSetCategory: (c: Category) => void;
  onSetCountry: (c: string) => void;
  onClose: () => void;
  onRename: () => void;
  onRegenerate: () => void;
  onRevoke: () => void;
  onDelete: () => void;
  onCommand: (c: AgentCommand) => void;
}) {
  const m = server.latestMetrics;
  const network = sumNetwork(server);
  const vpnText = server.vpn_service ? (server.vpn_active ? `${server.vpn_service}: активен` : `${server.vpn_service}: не работает`) : 'не обнаружен';
  const bridges = server.bridges || m?.bridges || [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <Flag cc={server.country} size="lg" />
            <div>
              <h2>{server.name} <button className="rename-btn" title="Переименовать" onClick={onRename}>✎</button></h2>
              <p>{server.ip} · {countryName(server.country)}</p>
            </div>
          </div>

          <div className="modal-head-actions">
            <CountrySelect value={server.country} onChange={onSetCountry} />
            <select className="input cat-select" value={server.category || 'other'} onChange={(e) => onSetCategory(e.target.value as Category)} title="Категория ноды">
              {(Object.keys(categoryLabel) as Category[]).map((c) => <option key={c} value={c}>{categoryLabel[c]}</option>)}
            </select>
            <HealthBadge health={server.health} />
            <span className={`badge ${server.status}`}>
              <span className="dot" />
              {statusLabel[server.status]}
            </span>

            <button className="modal-close" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="actions modal-actions">
          <button className="btn-secondary" disabled={!canCommand(server.status, 'start')} onClick={() => onCommand('start')}>▶ Запустить</button>
          <button className="btn-secondary" disabled={!canCommand(server.status, 'stop')} onClick={() => onCommand('stop')}>⏸ Остановить</button>
          <button className="btn-secondary" disabled={!canCommand(server.status, 'restart')} onClick={() => onCommand('restart')}>⟳ Перезапустить</button>
          <button className="btn-danger" disabled={!canCommand(server.status, 'delete')} onClick={() => onCommand('delete')}>✕ Удалить агента с ноды</button>
        </div>
        <div className="actions modal-actions">
          <button className="btn-secondary" disabled={!canCommand(server.status, 'update')} onClick={() => onCommand('update')}>⬆ Обновить агента</button>
          <button className="btn-secondary" disabled={!canCommand(server.status, 'check-config')} onClick={() => onCommand('check-config')}>✓ Проверить конфиг</button>
          <button className="btn-secondary" disabled={!canCommand(server.status, 'logs')} onClick={() => onCommand('logs')}>⤓ Запросить логи агента</button>
        </div>
        <div className="actions modal-actions">
          <button className="btn-secondary" onClick={onRegenerate}>Сгенерировать команду агента</button>
          <button className="btn-secondary" onClick={onRevoke}>Отозвать доступ агента</button>
          <button className="btn-danger" onClick={onDelete}>Удалить из панели</button>
        </div>

        {!m && (
          <div className="stale-notice">
            {server.status === 'offline' ? 'Нода оффлайн — свежих метрик нет. Показаны только последние известные метаданные.' :
             server.status === 'paused' ? 'Сбор метрик приостановлен. Нажми «Запустить», чтобы возобновить.' :
             'Метрик пока нет — ожидаем первую отправку от агента.'}
          </div>
        )}

        <div className="detail-grid adaptive-detail-grid">
          <Metric title="CPU" value={pct(m?.cpu_usage_percent)} percent={m?.cpu_usage_percent} />
          <Metric title="RAM" value={pct(m?.memory_usage_percent)} percent={m?.memory_usage_percent} />
          <Metric title="Диск /" value={pct(m?.disk_usage_percent)} percent={m?.disk_usage_percent} />
          <Metric title="Подключения" value={String(m?.total_connections ?? '—')} />

          <Metric title="Входящий сейчас" value={bps(m?.inbound_bps)} />
          <Metric title="Исходящий сейчас" value={bps(m?.outbound_bps)} />
          <Metric title="Входящий всего" value={bytes(network.rxTotal)} />
          <Metric title="Исходящий всего" value={bytes(network.txTotal)} />

          <Metric title="RAM всего" value={bytes(m?.memory_total_bytes)} />
          <Metric title="RAM занято" value={bytes(m?.memory_used_bytes)} />
          <Metric title="RAM свободно" value={bytes(m?.memory_free_bytes)} />
          <Metric title="Swap" value={`${bytes(m?.swap_used_bytes)} / ${bytes(m?.swap_total_bytes)}`} />

          <Metric title="Диск всего" value={bytes(m?.disk_total_bytes)} />
          <Metric title="Диск занято" value={bytes(m?.disk_used_bytes)} />
          <Metric title="Диск свободно" value={bytes(m?.disk_free_bytes)} />
          <Metric title="Uptime" value={uptime(m?.uptime_seconds)} />

          <Metric title="CPU model" value={m?.cpu_model || '—'} small />
          <Metric title="Ядра / потоки" value={`${m?.cpu_cores ?? '—'} / ${m?.cpu_threads ?? '—'}`} />
          <Metric title="OS" value={m?.os || '—'} small />
          <Metric title="Kernel" value={m?.kernel || '—'} small />

          <Metric title="Версия агента" value={server.agent_version || '—'} small />
          <Metric title="Последний пакет" value={ago(server.last_seen_at)} small />
          <Metric title="Задержка агента" value={server.agent_latency_ms != null ? `${server.agent_latency_ms} ms` : '—'} />
          <Metric title="Ping" value={m?.ping_ms != null ? `${m.ping_ms} ms` : '—'} />
          <Metric title="VPN-сервис" value={vpnText} small />
          <Metric title="Ошибки/дропы сети" value={`${m?.net_err_per_sec ?? 0} / ${m?.net_drop_per_sec ?? 0} /с`} />
        </div>

        <div className="section-title-row" style={{ margin: '18px 0 10px' }}>
          <span className="settings-label">История метрик</span>
          <div className="range-switch">
            {(['30m', '1h', '2h'] as const).map((r) => (
              <button key={r} className={`range-btn ${historyRange === r ? 'active' : ''}`} onClick={() => onRangeChange(r)}>{r}</button>
            ))}
          </div>
        </div>

        <div className="charts-grid">
          <MiniChart title="CPU" data={history} unit="%" series={[{ key: 'cpu_usage_percent', color: 'var(--series-cpu)', label: 'CPU' }]} />
          <MiniChart title="RAM" data={history} unit="%" series={[{ key: 'memory_usage_percent', color: 'var(--series-ram)', label: 'RAM' }]} />
          <MiniChart title="Диск" data={history} unit="%" series={[{ key: 'disk_usage_percent', color: 'var(--series-disk)', label: 'Диск' }]} />
          <MiniChart title="Сеть" data={history} unit="bps" series={[
            { key: 'inbound_bps', color: 'var(--series-net-in)', label: 'Вход' },
            { key: 'outbound_bps', color: 'var(--series-net-out)', label: 'Исход' },
          ]} />
        </div>

        <div className="modal-sections">
          {(server.category === 'bs' || bridges.length > 0) && (
            <section className="detail-metric bridges-section">
              <div className="section-title-row">
                <span className="settings-label">Мосты HAProxy{bridges.length ? ` · ${bridges.length}` : ''}</span>
                <button className="btn-secondary" disabled={!canCommand(server.status, 'bridge-check')} onClick={() => onCommand('bridge-check')}>Проверить мосты</button>
              </div>
              <div className="bridge-hint muted">Результат проверки (TCP до каждого моста) появится в блоке «Логи агента» после следующего опроса.</div>
              {bridges.length === 0 ? (
                <div className="muted">HAProxy не обнаружен или мостов нет. Нужен агент ≥ 1.6.0 и haproxy.cfg с backend/server (stats-сокет не обязателен — читается master-сокет или сам конфиг).</div>
              ) : (
                <div className="bridge-list">
                  {bridges.map((b, i) => {
                    const st = String(b.status || '').toUpperCase();
                    const state = st.startsWith('DOWN') ? 'down' : (st.startsWith('UP') || st === 'NO CHECK' || st === 'OPEN') ? 'up' : 'other';
                    return (
                      <div className={`bridge-row bridge-${state}`} key={`${b.backend}${b.name}${i}`}>
                        <span className="bridge-dot" />
                        <div className="bridge-main">
                          <strong>{b.backend}/{b.name}</strong>
                          <div className="muted">{b.addr || '—'}{b.check_status ? ` · check: ${b.check_status}` : ''}</div>
                        </div>
                        <div className="bridge-stat"><span className="muted">статус</span><b>{b.status || '—'}</b></div>
                        <div className="bridge-stat"><span className="muted">сессии</span><b>{b.sessions ?? 0}</b></div>
                        <div className="bridge-stat"><span className="muted">↓ / ↑</span><b>{bytes(b.bytes_in)} / {bytes(b.bytes_out)}</b></div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          <section className="detail-metric">
            <span>Сетевые интерфейсы</span>

            <div className="interfaces-list">
              {network.interfaces.length ? (
                network.interfaces.map((i: any) => (
                  <div className="interface-row" key={i.interface}>
                    <div>
                      <strong>{i.interface}</strong>
                      <div className="muted">{i.ip || 'без IPv4'} · {i.status || 'unknown'}</div>
                    </div>

                    <div>
                      <div>↓ {bps(Number(i.rx_bytes_per_sec || 0))}</div>
                      <div className="muted">всего ↓ {bytes(Number(i.rx_total_bytes || 0))}</div>
                    </div>

                    <div>
                      <div>↑ {bps(Number(i.tx_bytes_per_sec || 0))}</div>
                      <div className="muted">всего ↑ {bytes(Number(i.tx_total_bytes || 0))}</div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="muted">Данных по интерфейсам пока нет.</div>
              )}
            </div>
          </section>

          <section className="detail-metric">
            <span>История команд</span>
            <div className="command-log">
              {commandLog.length === 0 && <div className="muted">Команды ещё не отправлялись.</div>}
              {commandLog.map((c) => (
                <div className="command-row" key={c.id}>
                  <span className={`cmd-status ${c.status}`}>{c.status === 'pending' ? 'ожидает' : 'доставлена'}</span>
                  <span>{c.command}</span>
                  <span className="muted">{when(c.created_at)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="detail-metric">
            <span>Топ процессов по CPU</span>
            <div className="proc-list">
              {m?.top_cpu && m.top_cpu.length ? m.top_cpu.map((p) => (
                <div className="proc-row" key={`c${p.pid}`}><span className="proc-name">{p.name || '—'}</span><span className="muted">pid {p.pid}</span><strong>{p.cpu}%</strong></div>
              )) : <div className="muted">Нет данных — обнови агента до v{AGENT_LATEST_VERSION}.</div>}
            </div>
          </section>

          <section className="detail-metric">
            <span>Топ процессов по RAM</span>
            <div className="proc-list">
              {m?.top_mem && m.top_mem.length ? m.top_mem.map((p) => (
                <div className="proc-row" key={`m${p.pid}`}><span className="proc-name">{p.name || '—'}</span><span className="muted">pid {p.pid}</span><strong>{p.mem}%</strong></div>
              )) : <div className="muted">Нет данных — обнови агента до v{AGENT_LATEST_VERSION}.</div>}
            </div>
          </section>

          <section className="detail-metric">
            <span>Логи агента{agentLogs?.at ? ` · ${ago(agentLogs.at)}` : ''}</span>
            <pre className="raw-box logs-box">{agentLogs?.logs || 'Логи ещё не запрашивались. Нажми «Запросить логи агента» — они появятся после следующего опроса агента.'}</pre>
          </section>

          <section className="detail-metric">
            <span>Команда установки агента</span>
            <pre className="raw-box">
              {install || 'Нажми «Сгенерировать команду агента», чтобы получить одноразовую команду установки.'}
            </pre>
          </section>

          <section className="detail-metric">
            <span>Последний raw payload</span>
            <pre className="raw-box">{m?.raw ? JSON.stringify(m.raw, null, 2) : 'Метрики ещё не получены.'}</pre>
          </section>
        </div>
      </section>
    </div>
  );
}

function Metric({
  title,
  value,
  percent,
  small,
}: {
  title: string;
  value: string;
  percent?: number | null;
  small?: boolean;
}) {
  return (
    <div className="detail-metric">
      <span>{title}</span>
      <strong style={{ fontSize: small ? 14 : undefined }}>{value}</strong>

      {percent !== undefined && percent !== null && (
        <div className="bar">
          <span style={{ width: `${barWidth(percent)}%` }} />
        </div>
      )}
    </div>
  );
}

// ---- problems ----

function ProblemGroup({ title, level, children }: { title: string; level: 'critical' | 'warning' | 'info'; children: ReactNode }) {
  return (
    <div className={`problem-group level-${level}`}>
      <div className="problem-group-title">{title}</div>
      <div className="problem-rows">{children}</div>
    </div>
  );
}

function ProblemRow({ name, detail, action, onOpen, country }: {
  name: string;
  detail: string;
  action?: { label: string; onClick: () => void } | null;
  onOpen?: () => void;
  country?: string | null;
}) {
  return (
    <div className="problem-row">
      <span className="problem-dot" />
      <Flag cc={country} size="sm" />
      <div className="problem-body">
        <strong>{name}</strong>
        <div className="muted">{detail}</div>
      </div>
      {action && <button className="btn-secondary" onClick={action.onClick}>{action.label}</button>}
      {onOpen && <button className="btn-secondary" onClick={onOpen}>Открыть</button>}
    </div>
  );
}

function ProblemsView({ problems, servers, onOpenServer, onSendCommand }: {
  problems: ProblemsData | null;
  servers: Server[];
  onOpenServer: (id: string) => void;
  onSendCommand: (server: Server, command: AgentCommand) => void;
}) {
  if (!problems) return <section className="card panel full-width-panel"><div className="muted">Загрузка…</div></section>;
  const find = (id: string) => servers.find((s) => s.id === id);
  if (problems.total === 0) {
    return (
      <section className="card panel full-width-panel">
        <div className="panel-head"><div><div className="panel-title">Проблемы сейчас</div><div className="panel-subtitle">Только то, что требует внимания.</div></div></div>
        <div className="empty-good">✓ Всё спокойно — активных проблем нет.</div>
      </section>
    );
  }
  return (
    <section className="card panel full-width-panel">
      <div className="panel-head"><div><div className="panel-title">Проблемы сейчас</div><div className="panel-subtitle">Только то, что требует внимания. Всего пунктов: {problems.total}</div></div></div>
      <div className="problem-groups">
        {problems.offline.length > 0 && (
          <ProblemGroup title={`Оффлайн — ${problems.offline.length}`} level="critical">
            {problems.offline.map((s) => <ProblemRow key={s.id} country={find(s.id)?.country} name={s.name} detail={`нет метрик · последний раз ${ago(s.last_seen_at)}`} onOpen={() => onOpenServer(s.id)} />)}
          </ProblemGroup>
        )}
        {problems.agentStale.length > 0 && (
          <ProblemGroup title={`Агент молчит — ${problems.agentStale.length}`} level="warning">
            {problems.agentStale.map((s) => { const srv = find(s.id); return <ProblemRow key={s.id} country={srv?.country} name={s.name} detail={`нет данных уже ${duration(s.seconds)}`} action={srv ? { label: 'Перезапустить', onClick: () => onSendCommand(srv, 'restart') } : null} onOpen={() => onOpenServer(s.id)} />; })}
          </ProblemGroup>
        )}
        {problems.highLoad.length > 0 && (
          <ProblemGroup title={`Высокая нагрузка — ${problems.highLoad.length}`} level="warning">
            {problems.highLoad.map((s) => <ProblemRow key={`${s.id}${s.kind}`} country={find(s.id)?.country} name={s.name} detail={`${kindLabel(s.kind)}${s.since ? ` · с ${when(s.since)}` : ''}`} onOpen={() => onOpenServer(s.id)} />)}
          </ProblemGroup>
        )}
        {problems.vpnDown.length > 0 && (
          <ProblemGroup title={`VPN не работает — ${problems.vpnDown.length}`} level="critical">
            {problems.vpnDown.map((s) => <ProblemRow key={s.id} country={find(s.id)?.country} name={s.name} detail={`сервис ${s.vpn_service || '?'} не активен`} onOpen={() => onOpenServer(s.id)} />)}
          </ProblemGroup>
        )}
        {problems.bridgesDown.length > 0 && (
          <ProblemGroup title={`Мосты HAProxy недоступны — ${problems.bridgesDown.length}`} level="critical">
            {problems.bridgesDown.map((b, i) => <ProblemRow key={`${b.id}${b.backend}${b.bridge}${i}`} country={find(b.id)?.country} name={b.name} detail={`мост ${b.backend}/${b.bridge}${b.addr ? ` [${b.addr}]` : ''} — статус ${b.status}`} onOpen={() => onOpenServer(b.id)} />)}
          </ProblemGroup>
        )}
        {problems.outdatedAgents.length > 0 && (
          <ProblemGroup title={`Старая версия агента — ${problems.outdatedAgents.length}`} level="info">
            {problems.outdatedAgents.map((s) => { const srv = find(s.id); return <ProblemRow key={s.id} country={srv?.country} name={s.name} detail={`версия ${s.agent_version || 'неизвестна'}, актуальная ${AGENT_LATEST_VERSION}`} action={srv && canCommand(srv.status, 'update') ? { label: 'Обновить', onClick: () => onSendCommand(srv, 'update') } : null} onOpen={() => onOpenServer(s.id)} />; })}
          </ProblemGroup>
        )}
        {(problems.duplicateIps?.length ?? 0) > 0 && (
          <ProblemGroup title={`Дубли по IP — ${problems.duplicateIps!.length}`} level="warning">
            {problems.duplicateIps!.map((d) => <ProblemRow key={d.ip} name={d.ip} detail={`${d.cnt} записи на один IP: ${d.names}. Оставьте одну (лишнюю удалите).`} />)}
          </ProblemGroup>
        )}
        {problems.telegram.length > 0 && (
          <ProblemGroup title="Уведомления" level="warning">
            {problems.telegram.map((t, i) => <ProblemRow key={i} name="Telegram" detail={t.message} />)}
          </ProblemGroup>
        )}
      </div>
    </section>
  );
}

// ---- metrics ----

function ProcList({ procs, kind }: { procs?: Proc[] | null; kind: 'cpu' | 'mem' }) {
  if (!procs || procs.length === 0) return <div className="muted">Нет данных — обнови агента до v{AGENT_LATEST_VERSION}.</div>;
  return (
    <div className="proc-list">
      {procs.map((p) => (
        <div className="proc-row" key={`${kind}${p.pid}`}>
          <span className="proc-name">{p.name || '—'}</span>
          <span className="muted">pid {p.pid}</span>
          <strong>{kind === 'cpu' ? p.cpu : p.mem}%</strong>
        </div>
      ))}
    </div>
  );
}

function MetricsView({ servers, serverId, setServerId, range, setRange, history }: {
  servers: Server[];
  serverId: string;
  setServerId: (id: string) => void;
  range: '1h' | '6h' | '24h' | '7d' | '30d';
  setRange: (r: '1h' | '6h' | '24h' | '7d' | '30d') => void;
  history: any[];
}) {
  const server = servers.find((s) => s.id === serverId);
  const isRaw = range === '1h' || range === '6h';
  const spanDays = !isRaw;                 // 24ч/7д/30д строятся из почасовых агрегатов — нужна дата на оси
  const m = server?.latestMetrics;
  const rangeLabel: Record<string, string> = { '1h': '1 час', '6h': '6 часов', '24h': '24 часа', '7d': '7 дней', '30d': '30 дней' };
  return (
    <>
      <section className="card panel full-width-panel">
        <div className="panel-head">
          <span className="panel-ico blue"><MetricsIcon /></span>
          <div>
            <div className="panel-title">Метрики</div>
            <div className="panel-subtitle">Глубокая аналитика по ноде. Диапазоны от 24ч строятся из почасовых агрегатов.</div>
          </div>
        </div>
        <div className="metrics-controls">
          <div className="country-pick" title="Нода">
            <Flag cc={server?.country} size="sm" />
            <select value={serverId} onChange={(e) => setServerId(e.target.value)} style={{ minWidth: 190 }}>
              {servers.length === 0 && <option value="">Нет нод</option>}
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="range-switch">
            {(['1h', '6h', '24h', '7d', '30d'] as const).map((r) => <button key={r} className={`range-btn ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>{r}</button>)}
          </div>
          {history.length > 0 && (
            <span className="muted">
              {rangeLabel[range]} · {history.length} точек · с {when(history[0]?.timestamp)} по {when(history[history.length - 1]?.timestamp)}
            </span>
          )}
        </div>
        {history.length === 0 ? (
          <div className="chart-empty">
            Нет данных за выбранный период. Для диапазонов 24ч+ используются почасовые агрегаты — они копятся
            с момента добавления ноды, поэтому у новых нод 7д и 30д поначалу показывают тот же отрезок, что и 24ч.
          </div>
        ) : (
          <div className="charts-grid">
            <MiniChart title="CPU" data={history} unit="%" spanDays={spanDays} series={[{ key: 'cpu_usage_percent', color: 'var(--series-cpu)', label: 'CPU' }]} />
            <MiniChart title="RAM" data={history} unit="%" spanDays={spanDays} series={[{ key: 'memory_usage_percent', color: 'var(--series-ram)', label: 'RAM' }]} />
            <MiniChart title="Диск" data={history} unit="%" spanDays={spanDays} series={[{ key: 'disk_usage_percent', color: 'var(--series-disk)', label: 'Диск' }]} />
            <MiniChart title="Сеть RX/TX" data={history} unit="bps" spanDays={spanDays} series={[{ key: 'inbound_bps', color: 'var(--series-net-in)', label: 'Вход' }, { key: 'outbound_bps', color: 'var(--series-net-out)', label: 'Исход' }]} />
            <MiniChart title="Health score" data={history} unit="%" spanDays={spanDays} series={[{ key: 'health_score', color: 'var(--series-cpu)', label: 'Health' }]} />
            <MiniChart title="Подключения" data={history} unit="count" spanDays={spanDays} series={[{ key: 'total_connections', color: 'var(--series-net-out)', label: 'Соединения' }]} />
            {isRaw && <MiniChart title="Load average" data={history} unit="count" spanDays={spanDays} series={[{ key: 'load_1', color: 'var(--series-cpu)', label: '1m' }, { key: 'load_5', color: 'var(--series-ram)', label: '5m' }, { key: 'load_15', color: 'var(--series-disk)', label: '15m' }]} />}
          </div>
        )}
      </section>

      <div className="settings-grid">
        <section className="card panel">
          <div className="panel-title">Топ процессов по CPU</div>
          <div className="panel-subtitle">По последним метрикам ноды.</div>
          <ProcList procs={m?.top_cpu} kind="cpu" />
        </section>
        <section className="card panel">
          <div className="panel-title">Топ процессов по RAM</div>
          <div className="panel-subtitle">По последним метрикам ноды.</div>
          <ProcList procs={m?.top_mem} kind="mem" />
        </section>
      </div>
    </>
  );
}

// ---- incidents ----

function IncidentsView({ incidents, hasMore, onShowMore, filter, setFilter, servers }: {
  servers: Server[];
  incidents: Incident[];
  hasMore: boolean;
  onShowMore: () => void;
  filter: 'all' | 'open' | 'resolved';
  setFilter: (f: 'all' | 'open' | 'resolved') => void;
}) {
  return (
    <section className="card panel full-width-panel">
      <div className="panel-head">
        <div><div className="panel-title">Инциденты</div><div className="panel-subtitle">Сгруппированные события — от начала проблемы до восстановления.</div></div>
        <div className="range-switch">
          {(['all', 'open', 'resolved'] as const).map((f) => <button key={f} className={`range-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'Все' : f === 'open' ? 'Открытые' : 'Закрытые'}</button>)}
        </div>
      </div>

      {incidents.length === 0 && <div className="muted">Инцидентов нет.</div>}

      <div className="incident-list">
        {incidents.map((i) => (
          <div key={i.id} className={`incident-row level-${i.level} status-${i.status}`}>
            <span className="alert-dot" />
            <Flag cc={servers.find((s) => s.id === i.server_id)?.country} size="sm" />
            <div className="incident-body">
              <div className="incident-title">
                <strong>{i.server_name}</strong>
                <span className="muted"> · {kindLabel(i.kind)}</span>
                <span className={`incident-status ${i.status}`}>{i.status === 'open' ? 'открыт' : 'восстановлен'}</span>
              </div>
              <div className="alert-message">{i.message}</div>
              <div className="incident-meta muted">
                Начало: {when(i.started_at)}{i.resolved_at ? ` · Конец: ${when(i.resolved_at)}` : ''} · Длительность: {i.status === 'open' ? duration((Date.now() - new Date(i.started_at).getTime()) / 1000) : duration(i.duration_seconds)} · Telegram: {i.telegram_notified ? 'отправлен' : 'нет'}
              </div>
            </div>
          </div>
        ))}
      </div>

      {hasMore && <div className="show-more-row"><button className="btn-secondary" onClick={onShowMore}>Показать ещё</button></div>}
    </section>
  );
}

// ---- updates ----

// Обновление самой панели: состояние приходит от хостового апдейтера через /api/system/update.
function PanelUpdatePanel({ pushToast, askConfirm }: {
  pushToast: (text: string, kind?: Toast['kind']) => void;
  askConfirm: (title: string, message: string, danger?: boolean) => Promise<boolean>;
}) {
  const [data, setData] = useState<PanelUpdate | null>(null);
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);

  const load = () => api('/api/system/update').then(setData).catch(() => undefined);

  useEffect(() => {
    load();
    // Пока обновление идёт — опрашиваем чаще, чтобы статус не «залипал».
    const fast = data?.state?.status === 'running';
    const t = setInterval(load, fast ? 3000 : 20000);
    return () => clearInterval(t);
  }, [data?.state?.status]);

  async function check() {
    setBusy('check');
    try {
      const r = await api('/api/system/update/check', { method: 'POST' });
      if (r?.ok) pushToast('Проверяю обновления…');
      else pushToast('Канал обновлений недоступен', 'error');
      setTimeout(load, 2500);
      setTimeout(load, 6000);
    } catch { pushToast('Не удалось запросить проверку', 'error'); }
    finally { setTimeout(() => setBusy(null), 2500); }
  }

  async function apply() {
    const ok = await askConfirm(
      'Обновить панель',
      'Панель скачает свежую версию с GitHub, пересоберёт образы и перезапустит контейнеры. ' +
      'На время пересборки панель и API будут недоступны примерно минуту. Ноды и метрики не пострадают.',
    );
    if (!ok) return;
    setBusy('apply');
    try {
      const r = await api('/api/system/update/apply', { method: 'POST' });
      if (r?.ok) pushToast('Обновление запущено — панель перезапустится сама');
      else pushToast('Канал обновлений недоступен', 'error');
      setTimeout(load, 3000);
    } catch { pushToast('Не удалось запустить обновление', 'error'); }
    finally { setTimeout(() => setBusy(null), 4000); }
  }

  if (!data) return null;

  const st = data.state;
  const running = st?.status === 'running';
  const available = Boolean(st?.updateAvailable);

  return (
    <section className="card panel full-width-panel">
      <div className="panel-head">
        <span className={`panel-ico ${available ? 'amber' : ''}`}><UpdatesIcon /></span>
        <div>
          <div className="panel-title">Обновление панели</div>
          <div className="panel-subtitle">
            {data.channelReady
              ? <>Исходники обновляются с GitHub. Проверка выполняется автоматически каждые 30 минут.</>
              : <>Панель развёрнута вручную — канал обновлений недоступен. Переустановите её через <code>scripts/install.sh</code>, чтобы включить обновление одной кнопкой.</>}
          </div>
        </div>

        {data.channelReady && (
          <div className="actions" style={{ marginLeft: 'auto' }}>
            <button className="btn-secondary" onClick={check} disabled={busy !== null || running}>
              {busy === 'check' ? 'Проверяю…' : 'Проверить обновления'}
            </button>
            <button className="btn" onClick={apply} disabled={busy !== null || running || !available}>
              {running ? 'Обновляется…' : available ? 'Обновить панель' : 'Обновлений нет'}
            </button>
          </div>
        )}
      </div>

      <div className="strip" style={{ marginTop: 0 }}>
        <div className="strip-cell"><div className="l">Версия панели</div><div className="v">{data.versions.backend}</div></div>
        <div className="strip-cell"><div className="l">Установлено</div><div className="v">{st?.localShort || data.versions.buildHash}</div></div>
        <div className="strip-cell"><div className="l">На GitHub</div><div className="v" style={{ color: available ? 'var(--amber)' : undefined }}>{st?.remoteShort || '—'}</div></div>
        <div className="strip-cell"><div className="l">Отставание</div><div className="v" style={{ color: available ? 'var(--amber)' : undefined }}>{st?.behind ? `${st.behind} коммит(ов)` : 'нет'}</div></div>
        <div className="strip-cell"><div className="l">Ветка</div><div className="v" style={{ fontSize: 12 }}>{st?.currentBranch || '—'}</div></div>
        <div className="strip-cell"><div className="l">Проверено</div><div className="v" style={{ fontSize: 12 }}>{st?.checkedAt ? ago(st.checkedAt) : '—'}</div></div>
      </div>

      {st?.status === 'error' && <div className="error">{st.message || 'Ошибка обновления'}</div>}

      {running && (
        <div className="stale-notice">
          {st?.message || 'Обновление выполняется'} — панель перезапустится автоматически, страницу можно не трогать.
        </div>
      )}

      {!running && available && (
        <div className="stale-notice" style={{ borderColor: 'rgba(255,197,92,.2)' }}>
          Доступна новая версия{st?.latestSubject ? `: ${st.latestSubject}` : ''}.
        </div>
      )}

      {!running && !available && st?.status === 'idle' && (
        <div className="empty-good">✓ Установлена последняя версия панели.</div>
      )}
    </section>
  );
}

function UpdatesView({ versions, servers, onSendCommand, pushToast, askConfirm }: {
  versions: VersionsData | null;
  servers: Server[];
  onSendCommand: (server: Server, command: AgentCommand) => void;
  pushToast: (text: string, kind?: Toast['kind']) => void;
  askConfirm: (title: string, message: string, danger?: boolean) => Promise<boolean>;
}) {
  const [showChangelog, setShowChangelog] = useState(false);
  if (!versions) return <section className="card panel full-width-panel"><div className="muted">Загрузка…</div></section>;
  const find = (id: string) => servers.find((s) => s.id === id);
  const updatable = versions.agents.filter((a) => a.outdated).map((a) => find(a.id)).filter((s): s is Server => Boolean(s) && canCommand((s as Server).status, 'update'));

  async function updateAll() {
    if (updatable.length === 0) { pushToast('Нет доступных для обновления агентов', 'info'); return; }
    if (!(await askConfirm('Обновить агентов', `Отправить команду обновления на ${updatable.length} нод(ы)? Каждый агент скачает версию ${versions!.agentLatest} и перезапустится.`))) return;
    for (const s of updatable) onSendCommand(s, 'update');
    pushToast(`Команда обновления отправлена на ${updatable.length} нод(ы)`);
  }

  return (
    <>
      <PanelUpdatePanel pushToast={pushToast} askConfirm={askConfirm} />

      <section className="summary-grid">
        <SummaryCard label="Backend" value={versions.backend} sub="версия панели (API)" />
        <SummaryCard label="Frontend" value={versions.frontend} sub="версия панели (UI)" />
        <SummaryCard label="Агент (актуальный)" value={versions.agentLatest} sub="раздаётся панелью" />
        <SummaryCard label="Build hash" value={versions.buildHash} sub={versions.buildTime ? `сборка ${when(versions.buildTime)}` : 'последний деплой'} />
        <SummaryCard label="Агентов актуально" value={versions.counts.upToDate} sub={`из ${versions.counts.total}`} tone="good" />
        <SummaryCard label="Агентов устарело" value={versions.counts.outdated} sub="ниже актуальной версии" tone={versions.counts.outdated ? 'warning' : undefined} />
        <SummaryCard label="Версия неизвестна" value={versions.counts.unknown} sub="агент не прислал версию" tone={versions.counts.unknown ? 'warning' : undefined} />
      </section>

      <section className="card panel full-width-panel">
        <div className="panel-head">
          <div><div className="panel-title">Обновления</div><div className="panel-subtitle">Центр версий панели и агентов.</div></div>
          <div className="actions">
            <button className="btn" disabled={updatable.length === 0} onClick={updateAll}>Обновить все агенты{updatable.length ? ` (${updatable.length})` : ''}</button>
            <button className="btn-secondary" onClick={() => setShowChangelog((v) => !v)}>Changelog</button>
          </div>
        </div>

        {showChangelog && <pre className="raw-box">{CHANGELOG}</pre>}

        <div className="table-wrap">
          <table>
            <thead><tr><th>Нода</th><th>Статус</th><th>Версия агента</th><th>Актуальность</th><th></th></tr></thead>
            <tbody>
              {versions.agents.length === 0 && <tr><td colSpan={5} className="muted">Нет нод с установленным агентом.</td></tr>}
              {versions.agents.map((a) => {
                const srv = find(a.id);
                return (
                  <tr key={a.id}>
                    <td>
                      <div className="node-cell">
                        <Flag cc={srv?.country} size="sm" />
                        <div className="node-meta"><div className="server-name">{a.name}</div></div>
                      </div>
                    </td>
                    <td><span className={`badge ${a.status}`}><span className="dot" />{statusLabel[a.status]}</span></td>
                    <td>{a.agent_version || <span className="muted">неизвестна</span>}</td>
                    <td>{a.unknown ? <span className="muted">—</span> : a.outdated ? <span className="ver-badge outdated">устарел</span> : <span className="ver-badge ok">актуален</span>}</td>
                    <td>{a.outdated && srv && canCommand(srv.status, 'update') && <button className="btn-secondary" onClick={() => onSendCommand(srv, 'update')}>Обновить</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
