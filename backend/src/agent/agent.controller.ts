import { BadRequestException, Body, Controller, Get, Headers, Post, Req, Res } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { Request, Response } from 'express';
import { DbService } from '../db/db.service';
import { ServersService } from '../servers/servers.service';
@Controller()
export class AgentController {
  constructor(private readonly db: DbService, private readonly servers: ServersService) {}
  @Get('install.sh') install(@Res() res: Response) { res.type('text/x-shellscript').send(INSTALL_SCRIPT); }
  @Get('agent.py') agent(@Res() res: Response) { res.type('text/x-python').send(AGENT_PY); }
  @Post('api/agent/register') async register(@Body() body: any) { const serverId = String(body.server_id || ''), token = String(body.enrollment_token || ''); if (!serverId || !token) throw new BadRequestException('server_id and enrollment_token are required'); const secret = randomBytes(32).toString('hex'); await this.servers.registerAgent(serverId, token, secret); return { ok: true, agent_secret: secret, metrics_interval: Number(process.env.METRICS_INTERVAL_SECONDS || 5) }; }
  @Post('api/agent/metrics') async metrics(@Body() body: any, @Headers() headers: any, @Req() req: Request) {
    const { serverId, ts } = await this.verifyAgent(body, headers, req);
    const latencyMs = Math.max(0, Math.round(Date.now() - Number(ts) * 1000));
    await this.servers.storeMetrics(serverId, body, { latencyMs });
    const pending = await this.servers.pendingCommand(serverId);
    let command: string | null = null;
    let commandPayload: any = null;
    if (pending) {
      await this.servers.markCommandDelivered(pending.id);
      command = pending.command;
      commandPayload = pending.payload ?? null;
      if (command === 'delete') await this.servers.revoke(serverId);
    }
    return { ok: true, command, command_payload: commandPayload, metrics_interval: Number(process.env.METRICS_INTERVAL_SECONDS || 5) };
  }
  @Post('api/agent/logs') async logs(@Body() body: any, @Headers() headers: any, @Req() req: Request) {
    const { serverId } = await this.verifyAgent(body, headers, req);
    await this.servers.storeAgentLogs(serverId, String(body?.logs || ''));
    return { ok: true };
  }
  private async verifyAgent(body: any, headers: any, req: Request): Promise<{ serverId: string; ts: string }> {
    const serverId = String(headers['x-server-id'] || ''), ts = String(headers['x-timestamp'] || ''), sig = String(headers['x-signature'] || '');
    if (!serverId || !ts || !sig) throw new BadRequestException('missing auth headers');
    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > 60) throw new BadRequestException('timestamp skew');
    const secret = await this.servers.getAgentSecret(serverId);
    if (!secret) throw new BadRequestException('unknown server');
    const raw = (req as any).rawBody || JSON.stringify(body);
    const expected = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
    if (!this.safeEqual(expected, sig)) throw new BadRequestException('bad signature');
    try { await this.db.query('insert into replay_nonces(server_id,ts,signature) values($1,$2,$3)', [serverId, ts, sig]); } catch { throw new BadRequestException('replay request'); }
    return { serverId, ts };
  }
  private safeEqual(a: string, b: string) { if (a.length !== b.length) return false; let out = 0; for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i); return out === 0; }
}
const INSTALL_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail
PANEL_URL=""; SERVER_ID=""; TOKEN=""
while [[ $# -gt 0 ]]; do case "$1" in --panel-url) PANEL_URL="$2"; shift 2 ;; --server-id) SERVER_ID="$2"; shift 2 ;; --token) TOKEN="$2"; shift 2 ;; *) echo "Unknown argument: $1"; exit 1 ;; esac; done
if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root: sudo ./install-eclipse-agent.sh ..."; exit 1; fi
if [[ -z "$PANEL_URL" || -z "$SERVER_ID" || -z "$TOKEN" ]]; then echo "Usage: $0 --panel-url https://panel.domain --server-id UUID --token TOKEN"; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then apt-get update; apt-get install -y curl ca-certificates python3 python3-pip python3-venv iproute2 procps util-linux; elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates python3 python3-pip iproute procps-ng util-linux; else echo "Unsupported OS"; exit 1; fi
mkdir -p /opt/eclipse-agent /etc/eclipse-agent /var/log/eclipse-agent
python3 -m venv /opt/eclipse-agent/venv
/opt/eclipse-agent/venv/bin/pip install --upgrade pip >/dev/null
/opt/eclipse-agent/venv/bin/pip install requests psutil pyyaml >/dev/null
curl -fsSL "$PANEL_URL/agent.py" -o /opt/eclipse-agent/eclipse-agent.py
chmod +x /opt/eclipse-agent/eclipse-agent.py
REGISTER_RESPONSE="$(curl -fsSL -X POST "$PANEL_URL/api/agent/register" -H "Content-Type: application/json" -d "{\"server_id\":\"$SERVER_ID\",\"enrollment_token\":\"$TOKEN\",\"hostname\":\"$(hostname)\",\"public_ip\":\"$(curl -fsSL https://api.ipify.org || true)\"}")"
AGENT_SECRET="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_secret"])' <<< "$REGISTER_RESPONSE")"
INTERVAL="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("metrics_interval",5))' <<< "$REGISTER_RESPONSE")"
cat > /etc/eclipse-agent/config.yml <<EOF_CONFIG
panel_url: "$PANEL_URL"
server_id: "$SERVER_ID"
agent_secret: "$AGENT_SECRET"
interval_seconds: $INTERVAL
verify_tls: true
vpn_service: ""
haproxy_socket: ""
ports:
  from: 1441
  to: 9443
EOF_CONFIG
chmod 600 /etc/eclipse-agent/config.yml; chown root:root /etc/eclipse-agent/config.yml
cat > /etc/systemd/system/eclipse-agent.service <<'EOF_SERVICE'
[Unit]
Description=Eclipse Server Monitoring Agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/opt/eclipse-agent/venv/bin/python /opt/eclipse-agent/eclipse-agent.py --config /etc/eclipse-agent/config.yml
Restart=always
RestartSec=5
User=root
StandardOutput=append:/var/log/eclipse-agent/agent.log
StandardError=append:/var/log/eclipse-agent/agent.log
[Install]
WantedBy=multi-user.target
EOF_SERVICE
cat > /usr/local/bin/eclipse <<'EOF_CLI'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root: sudo eclipse <command>"; exit 1; fi
if [[ $# -eq 0 ]]; then echo "Usage: eclipse {start|stop|restart|delete|status}"; exit 1; fi
case "$1" in
  start) systemctl start eclipse-agent ;;
  stop) systemctl stop eclipse-agent ;;
  restart) systemctl restart eclipse-agent ;;
  status) systemctl status eclipse-agent --no-pager ;;
  delete)
    systemctl stop eclipse-agent 2>/dev/null || true
    systemctl disable eclipse-agent 2>/dev/null || true
    rm -f /etc/systemd/system/eclipse-agent.service
    systemctl daemon-reload
    rm -rf /opt/eclipse-agent /etc/eclipse-agent /var/log/eclipse-agent
    rm -f /usr/local/bin/eclipse
    echo "Eclipse agent removed."
    ;;
  *) echo "Usage: eclipse {start|stop|restart|delete|status}"; exit 1 ;;
esac
EOF_CLI
chmod +x /usr/local/bin/eclipse
systemctl daemon-reload; systemctl enable eclipse-agent; systemctl restart eclipse-agent
sleep 2; systemctl --no-pager status eclipse-agent || true
echo "Eclipse agent installed. Logs: journalctl -u eclipse-agent -f"
echo "Manage locally with: eclipse {start|stop|restart|delete|status}"`;
const AGENT_PY = String.raw`#!/usr/bin/env python3
import argparse, hashlib, hmac, json, os, platform, socket, subprocess, sys, time
import psutil, requests, yaml

AGENT_VERSION = '1.7.1'
_BRIDGE_CACHE={'ts':0.0,'data':None}
BRIDGE_REFRESH=30

def load_config(path):
    with open(path, 'r', encoding='utf-8') as f: return yaml.safe_load(f)
def public_ip():
    try: return requests.get('https://api.ipify.org', timeout=2).text.strip()
    except Exception: return ''
def local_ip():
    try:
        s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(('1.1.1.1',80)); ip=s.getsockname()[0]; s.close(); return ip
    except Exception: return ''
def os_name():
    try:
        data={}
        for line in open('/etc/os-release', encoding='utf-8'):
            if '=' in line:
                k,v=line.strip().split('=',1); data[k]=v.strip('"')
        return data.get('PRETTY_NAME') or platform.platform()
    except Exception: return platform.platform()
def cpu_model():
    try:
        for line in open('/proc/cpuinfo', encoding='utf-8'):
            if line.lower().startswith('model name'): return line.split(':',1)[1].strip()
    except Exception: pass
    return platform.processor() or 'unknown'
def iface_ips():
    out={}
    for name, addrs in psutil.net_if_addrs().items():
        for a in addrs:
            if getattr(a,'family',None)==socket.AF_INET: out[name]=a.address; break
    return out
def collect_connections(port_from, port_to):
    result={}
    try:
        output=subprocess.check_output(['ss','-Htan'], text=True, timeout=4, stderr=subprocess.DEVNULL)
        for line in output.splitlines():
            parts=line.split()
            if len(parts)<4: continue
            state=parts[0].upper(); local=parts[3]
            if ':' not in local: continue
            try: port=int(local.rsplit(':',1)[1])
            except ValueError: continue
            if not (port_from <= port <= port_to): continue
            item=result.setdefault(port, {'port':port,'protocol':'tcp','established':0,'listening':False})
            if state=='ESTAB': item['established']+=1
            elif state=='LISTEN': item['listening']=True
    except Exception: pass
    return sorted(result.values(), key=lambda x:x['port'])
def ping_ms(host='1.1.1.1', port=53):
    try:
        start=time.time(); s=socket.create_connection((host,port),timeout=2); s.close()
        return round((time.time()-start)*1000,1)
    except Exception: return None
VPN_CANDIDATES=['xray','sing-box','v2ray','x-ui','3x-ui','openvpn','openvpn@server','wg-quick@wg0','wg-quick@wg1','wireguard','strongswan','ipsec']
def _svc_state(name):
    try: return subprocess.run(['systemctl','is-active',name],capture_output=True,text=True,timeout=3).stdout.strip()
    except Exception: return ''
def _svc_enabled(name):
    try: return subprocess.run(['systemctl','is-enabled',name],capture_output=True,text=True,timeout=3).stdout.strip()
    except Exception: return ''
def detect_vpn(cfg):
    override=(cfg.get('vpn_service') or '').strip()
    if override.lower() in ('none','off','-','disable','disabled','no'): return None
    if override:
        # админ явно указал сервис — сообщаем как есть (inactive = проблема)
        return {'service':override,'active':_svc_state(override)=='active'}
    # авто-режим: сообщаем ТОЛЬКО реально используемый VPN (active сейчас или enabled в автозапуск).
    # Просто установленный, но не настроенный сервис (напр. wg-quick@wg0) — игнорируем, не считаем проблемой.
    for name in VPN_CANDIDATES:
        if _svc_state(name)=='active': return {'service':name,'active':True}
    for name in VPN_CANDIDATES:
        if _svc_enabled(name) in ('enabled','enabled-runtime'): return {'service':name,'active':False}
    return None
HAPROXY_CFG_PATHS=['/etc/haproxy/haproxy.cfg','/usr/local/etc/haproxy/haproxy.cfg','/opt/haproxy/haproxy.cfg']
SOCK_CANDIDATES=['/run/haproxy/admin.sock','/var/run/haproxy/admin.sock','/run/haproxy/stats.sock','/run/haproxy.sock','/var/run/haproxy.sock']
def _haproxy_cfg_path(cfg):
    p=cfg.get('haproxy_config')
    if p and os.path.exists(p): return p
    for c in HAPROXY_CFG_PATHS:
        if os.path.exists(c): return c
    return None
def _parse_haproxy_config(path):
    conf={'socket':None,'servers':[]}
    if not path: return conf
    try:
        cur=None
        for raw in open(path, encoding='utf-8', errors='replace'):
            line=raw.strip()
            if not line or line.startswith('#'): continue
            low=line.lower()
            if low.startswith('stats socket'):
                parts=line.split()
                if len(parts)>=3 and parts[2].startswith('/'): conf['socket']=parts[2]
                continue
            if low.startswith('backend ') or low.startswith('listen '):
                p=line.split(); cur=p[1] if len(p)>1 else None; continue
            if low.startswith('frontend ') or low.startswith('defaults') or low.startswith('global') or low.startswith('peers ') or low.startswith('resolvers '):
                cur=None; continue
            if low.startswith('server ') and cur:
                p=line.split()
                if len(p)>=3: conf['servers'].append({'backend':cur,'name':p[1],'addr':p[2]})
    except Exception: pass
    return conf
def _sock_cmd(path, cmd, timeout=3):
    try:
        s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(timeout); s.connect(path)
        s.sendall(cmd); buf=b''
        while True:
            try: ch=s.recv(65536)
            except socket.timeout: break  # мастер-сокет интерактивный: отдаём накопленное
            if not ch: break
            buf+=ch
            if len(buf)>2000000: break
        s.close(); return buf.decode('utf-8','replace') if buf else None
    except Exception: return None
def _parse_stat_csv(text):
    if not text: return None
    lines=text.splitlines(); hi=None
    for i,l in enumerate(lines):
        if 'pxname' in l and 'svname' in l: hi=i; break
    if hi is None: return None
    header=lines[hi].lstrip('# ').split(','); idx={n:i for i,n in enumerate(header)}
    def field(cols,name,default=''):
        i=idx.get(name); return cols[i] if i is not None and i<len(cols) else default
    def inum(v):
        try: return int(v)
        except Exception: return 0
    out=[]
    for l in lines[hi+1:]:
        if not l or l.startswith('#'): continue
        cols=l.split(',')
        sv=field(cols,'svname')
        if sv in ('','FRONTEND','BACKEND'): continue
        out.append({'backend':field(cols,'pxname'),'name':sv,'addr':field(cols,'addr'),'status':field(cols,'status'),'sessions':inum(field(cols,'scur')),'smax':inum(field(cols,'smax')),'bytes_in':inum(field(cols,'bin')),'bytes_out':inum(field(cols,'bout')),'check_status':field(cols,'check_status'),'downtime':inum(field(cols,'downtime')),'last_change':inum(field(cols,'lastchg'))})
        if len(out)>=100: break
    return out or None
def _tcp_status(addr, timeout=2):
    if not addr or ':' not in addr: return 'UNKNOWN'
    host,_,port=addr.rpartition(':')
    try: port=int(port)
    except Exception: return 'UNKNOWN'
    try:
        s=socket.create_connection((host,port),timeout=timeout); s.close(); return 'UP'
    except Exception: return 'DOWN'
def _is_local_addr(addr):
    if not addr: return False
    host=addr.rsplit(':',1)[0].strip('[]') if ':' in addr else addr
    return host in ('127.0.0.1','::1','localhost') or host.startswith('127.')
def _haproxy_active():
    try: return subprocess.run(['systemctl','is-active','haproxy'],capture_output=True,text=True,timeout=3).stdout.strip()=='active'
    except Exception: return False
def _collect_bridges_now(cfg):
    conf=_parse_haproxy_config(_haproxy_cfg_path(cfg))
    cands=[]
    if cfg.get('haproxy_socket'): cands.append(cfg.get('haproxy_socket'))
    if conf['socket']: cands.append(conf['socket'])
    cands+=SOCK_CANDIDATES
    text=None
    for p in cands:
        if p and os.path.exists(p):
            text=_sock_cmd(p, b'show stat\n')
            if text and 'pxname' in text: break
            text=None
    # master-worker CLI (haproxy -Ws -S): статистика без stats socket в конфиге
    if (not text or 'pxname' not in text):
        for mp in ('/run/haproxy-master.sock','/var/run/haproxy-master.sock'):
            if os.path.exists(mp):
                t=_sock_cmd(mp, b'@1 show stat\n')
                if t and 'pxname' in t: text=t; break
    live=_parse_stat_csv(text)
    if live:
        # исключаем локальные бэкенды (заглушка/локальный xray на 127.0.0.1) — это не мосты
        live=[b for b in live if not _is_local_addr(b.get('addr'))]
        return live or None
    # Fallback: рабочего stats-сокета нет — только если haproxy реально запущен, иначе это старый конфиг.
    servers=[sv for sv in conf['servers'][:100] if not _is_local_addr(sv.get('addr'))]
    if not servers or not _haproxy_active(): return None
    return [{'backend':sv['backend'],'name':sv['name'],'addr':sv['addr'],'status':_tcp_status(sv['addr']),'sessions':0,'check_status':'tcp-probe'} for sv in servers] or None
def collect_bridges(cfg):
    now=time.time()
    if _BRIDGE_CACHE['ts'] and (now-_BRIDGE_CACHE['ts'])<BRIDGE_REFRESH:
        return _BRIDGE_CACHE['data']
    try: data=_collect_bridges_now(cfg)
    except Exception: data=_BRIDGE_CACHE['data']
    _BRIDGE_CACHE['ts']=now; _BRIDGE_CACHE['data']=data
    return data
def top_processes(limit=5):
    procs=[]
    try:
        for p in psutil.process_iter(['pid','name']):
            try: p.cpu_percent(None)
            except Exception: pass
        time.sleep(0.15)
        ncpu=psutil.cpu_count(logical=True) or 1
        for p in psutil.process_iter(['pid','name','memory_percent']):
            try:
                info=p.info; procs.append({'pid':info['pid'],'name':(info.get('name') or '')[:40],'cpu':round(p.cpu_percent(None)/ncpu,1),'mem':round(info.get('memory_percent') or 0,1)})
            except Exception: continue
    except Exception: pass
    top_cpu=sorted(procs,key=lambda x:x['cpu'],reverse=True)[:limit]
    top_mem=sorted(procs,key=lambda x:x['mem'],reverse=True)[:limit]
    return top_cpu, top_mem
def collect(prev_net, cur_net, interval, cfg):
    vm=psutil.virtual_memory(); sm=psutil.swap_memory(); du=psutil.disk_usage('/'); load=os.getloadavg() if hasattr(os,'getloadavg') else (0,0,0)
    ips=iface_ips(); stats=psutil.net_if_stats(); network=[]; err_ps=0; drop_ps=0
    for name, cur in cur_net.items():
        prev=prev_net.get(name); rx=tx=0
        if prev and interval>0:
            rx=max(0,int((cur.bytes_recv-prev.bytes_recv)/interval)); tx=max(0,int((cur.bytes_sent-prev.bytes_sent)/interval))
            err_ps+=max(0,int(((cur.errin+cur.errout)-(prev.errin+prev.errout))/interval)); drop_ps+=max(0,int(((cur.dropin+cur.dropout)-(prev.dropin+prev.dropout))/interval))
        network.append({'interface':name,'rx_bytes_per_sec':rx,'tx_bytes_per_sec':tx,'rx_total_bytes':int(cur.bytes_recv),'tx_total_bytes':int(cur.bytes_sent),'err_in':int(cur.errin),'err_out':int(cur.errout),'drop_in':int(cur.dropin),'drop_out':int(cur.dropout),'status':'up' if stats.get(name) and stats[name].isup else 'down','ip':ips.get(name,'')})
    ports=cfg.get('ports') or {}; port_from=int(ports.get('from',1441)); port_to=int(ports.get('to',9443))
    top_cpu, top_mem = top_processes()
    return {'server_id':cfg['server_id'],'agent_version':AGENT_VERSION,'hostname':socket.gethostname(),'public_ip':public_ip(),'local_ip':local_ip(),'os':os_name(),'kernel':platform.release(),'uptime_seconds':int(time.time()-psutil.boot_time()),'cpu':{'model':cpu_model(),'cores':psutil.cpu_count(logical=False) or 0,'threads':psutil.cpu_count(logical=True) or 0,'usage_percent':psutil.cpu_percent(interval=0.1),'load_1':load[0],'load_5':load[1],'load_15':load[2]},'memory':{'total_bytes':int(vm.total),'used_bytes':int(vm.used),'free_bytes':int(vm.available),'usage_percent':float(vm.percent),'swap_total_bytes':int(sm.total),'swap_used_bytes':int(sm.used),'swap_usage_percent':float(sm.percent)},'disk':{'root':{'total_bytes':int(du.total),'used_bytes':int(du.used),'free_bytes':int(du.free),'usage_percent':float(du.percent)}},'network':network,'net_err_per_sec':err_ps,'net_drop_per_sec':drop_ps,'ping_ms':ping_ms(),'vpn':detect_vpn(cfg),'top_cpu':top_cpu,'top_mem':top_mem,'bridges':collect_bridges(cfg),'connections':collect_connections(port_from,port_to)}
def send_metrics(cfg, payload):
    body=json.dumps(payload,separators=(',',':'),ensure_ascii=False); ts=str(int(time.time())); sig=hmac.new(cfg['agent_secret'].encode(), f'{ts}.{body}'.encode(), hashlib.sha256).hexdigest(); url=cfg['panel_url'].rstrip('/')+'/api/agent/metrics'
    r=requests.post(url,data=body.encode('utf-8'),headers={'Content-Type':'application/json','X-Server-Id':cfg['server_id'],'X-Timestamp':ts,'X-Signature':sig},timeout=10,verify=bool(cfg.get('verify_tls',True))); r.raise_for_status(); return r.json()
def uninstall_self():
    script = 'sleep 1; systemctl stop eclipse-agent; systemctl disable eclipse-agent; rm -f /etc/systemd/system/eclipse-agent.service; systemctl daemon-reload; rm -rf /opt/eclipse-agent /etc/eclipse-agent /var/log/eclipse-agent; rm -f /usr/local/bin/eclipse'
    subprocess.Popen(['/bin/bash', '-c', script], start_new_session=True)
def agent_path():
    try: return os.path.abspath(__file__)
    except Exception: return '/opt/eclipse-agent/eclipse-agent.py'
def self_update(cfg):
    url=cfg['panel_url'].rstrip('/')+'/agent.py'
    r=requests.get(url,timeout=15,verify=bool(cfg.get('verify_tls',True))); r.raise_for_status()
    text=r.text
    if 'AGENT_VERSION' not in text or len(text)<500: raise RuntimeError('downloaded agent looks invalid')
    path=agent_path(); tmp=path+'.new'
    with open(tmp,'w',encoding='utf-8') as f: f.write(text)
    os.replace(tmp,path)
    # Перезапуск делаем в ОТДЕЛЬНОЙ сессии с задержкой: иначе systemctl restart выполняется внутри
    # cgroup самого сервиса и может быть убит при остановке (агент бы не перезапустился и остался бы на
    # старом коде). Основной механизм — выход процесса ниже (return 'exit') + Restart=always в unit'е;
    # этот отложенный restart — подстраховка.
    subprocess.Popen(['/bin/bash','-c','sleep 2; systemctl restart eclipse-agent'], start_new_session=True)
def read_logs(lines=200):
    try:
        with open('/var/log/eclipse-agent/agent.log','r',encoding='utf-8',errors='replace') as f: return ''.join(f.readlines()[-lines:])
    except Exception as e: return 'no logs available: '+repr(e)
def upload_logs(cfg, text):
    payload={'server_id':cfg['server_id'],'agent_version':AGENT_VERSION,'logs':text[-16000:]}
    body=json.dumps(payload,separators=(',',':'),ensure_ascii=False); ts=str(int(time.time()))
    sig=hmac.new(cfg['agent_secret'].encode(), (ts+'.'+body).encode(), hashlib.sha256).hexdigest()
    url=cfg['panel_url'].rstrip('/')+'/api/agent/logs'
    requests.post(url,data=body.encode('utf-8'),headers={'Content-Type':'application/json','X-Server-Id':cfg['server_id'],'X-Timestamp':ts,'X-Signature':sig},timeout=10,verify=bool(cfg.get('verify_tls',True)))
def check_bridges(cfg):
    bridges=collect_bridges(cfg) or []
    lines=['bridge check @ '+time.strftime('%Y-%m-%d %H:%M:%S'),'agent '+AGENT_VERSION]
    if not bridges:
        lines.append('HAProxy/мосты не обнаружены (нет stats-сокета или мостов)'); return '\n'.join(lines)
    for b in bridges:
        name=str(b.get('backend',''))+'/'+str(b.get('name',''))
        addr=b.get('addr') or ''
        probe='нет addr'
        if addr and ':' in addr:
            host,_,port=addr.rpartition(':')
            try:
                start=time.time(); s=socket.create_connection((host,int(port)),timeout=4); s.close(); probe='TCP OK '+str(round((time.time()-start)*1000,1))+' ms'
            except Exception as e: probe='TCP FAIL: '+type(e).__name__
        lines.append(name+' ['+(addr or '?')+'] haproxy='+str(b.get('status',''))+' check='+str(b.get('check_status',''))+' sessions='+str(b.get('sessions',0))+' | '+probe)
    return '\n'.join(lines)
def check_config(cfg):
    problems=[k for k in ('panel_url','server_id','agent_secret') if not cfg.get(k)]
    ports=cfg.get('ports') or {}
    lines=['config check @ '+time.strftime('%Y-%m-%d %H:%M:%S'),'agent_version: '+AGENT_VERSION,'panel_url: '+str(cfg.get('panel_url')),'server_id: '+str(cfg.get('server_id')),'interval_seconds: '+str(cfg.get('interval_seconds')),'ports: '+str(ports.get('from'))+'-'+str(ports.get('to')),'vpn_service: '+str(cfg.get('vpn_service') or 'auto'),'verify_tls: '+str(cfg.get('verify_tls',True)),('OK, config valid' if not problems else 'PROBLEMS: '+', '.join(problems))]
    return '\n'.join(lines)
def handle_command(cmd, payload, cfg):
    # returns 'stop' | 'start' | 'exit' | None
    if cmd=='stop': return 'stop'
    if cmd=='start': return 'start'
    if cmd=='restart': subprocess.Popen(['systemctl','restart','eclipse-agent']); return None
    if cmd=='update':
        try: self_update(cfg); return 'exit'
        except Exception as e: print('update error:', repr(e), flush=True); return None
    if cmd=='logs':
        try: upload_logs(cfg, read_logs())
        except Exception as e: print('logs upload error:', repr(e), flush=True)
        return None
    if cmd=='check-config':
        try: upload_logs(cfg, check_config(cfg))
        except Exception as e: print('check-config error:', repr(e), flush=True)
        return None
    if cmd=='bridge-check':
        try: upload_logs(cfg, check_bridges(cfg))
        except Exception as e: print('bridge-check error:', repr(e), flush=True)
        return None
    if cmd=='poweroff':
        # выключить САМ сервер (не агента). Возврат в строй — только вручную у провайдера.
        try: subprocess.Popen(['/bin/bash','-c','sleep 2; systemctl poweroff || shutdown -h now || poweroff'], start_new_session=True)
        except Exception as e: print('poweroff error:', repr(e), flush=True)
        return 'exit'
    if cmd=='delete': uninstall_self(); return 'exit'
    return None
def main():
    p=argparse.ArgumentParser(); p.add_argument('--config',default='/etc/eclipse-agent/config.yml'); p.add_argument('--once',action='store_true'); p.add_argument('--test',action='store_true'); p.add_argument('--version',action='store_true'); args=p.parse_args()
    if args.version: print('eclipse-agent '+AGENT_VERSION); return
    cfg=load_config(args.config); interval=int(cfg.get('interval_seconds',5)); prev=psutil.net_io_counters(pernic=True); prev_t=time.time()
    if args.once or args.test:
        # взять реальную дельту за короткий интервал, иначе скорость = 0
        time.sleep(1); cur=psutil.net_io_counters(pernic=True); payload=collect(prev, cur, max(time.time()-prev_t,0.5), cfg)
        if args.once: print(json.dumps(payload, indent=2, ensure_ascii=False))
        else: print(send_metrics(cfg, payload))
        return
    paused=False
    while True:
        time.sleep(interval)
        # Счётчики сети читаем РОВНО один раз за цикл и делим на реальное прошедшее время между
        # двумя чтениями (а не на номинальный interval) — иначе задержки collect()/send завышают скорость.
        cur=psutil.net_io_counters(pernic=True); now=time.time(); dt=max(now-prev_t, 0.5)
        if paused:
            payload={'server_id':cfg['server_id'],'agent_version':AGENT_VERSION,'hostname':socket.gethostname(),'heartbeat':True}
        else:
            try:
                payload=collect(prev, cur, dt, cfg)
            except Exception as e:
                print(time.strftime('%Y-%m-%d %H:%M:%S'),'collect error:',repr(e),flush=True); prev=cur; prev_t=now; continue
        prev=cur; prev_t=now
        try:
            resp=send_metrics(cfg,payload)
            print(time.strftime('%Y-%m-%d %H:%M:%S'), 'ok', 'paused' if paused else 'metrics sent', resp, flush=True)
            action=handle_command(resp.get('command'), resp.get('command_payload'), cfg)
            if action=='stop': paused=True
            elif action=='start': paused=False
            elif action=='exit': break
        except Exception as e: print(time.strftime('%Y-%m-%d %H:%M:%S'), 'send error:', repr(e), flush=True)
if __name__=='__main__': main()`;
