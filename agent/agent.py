#!/usr/bin/env python3
import os, time, json, hmac, hashlib, random, socket, requests

SERVER_ID = os.environ.get('SERVER_ID')
AGENT_SECRET = os.environ.get('AGENT_SECRET')
PANEL_URL = os.environ.get('PANEL_URL', 'https://localhost:3406')

def collect():
    return {
        "cpu_usage": random.uniform(0, 50),
        "memory_usage": random.uniform(0, 80),
    }

while True:
    payload = collect()
    ts = str(int(time.time()))
    body = json.dumps(payload, separators=(',', ':'))
    sig = hmac.new(AGENT_SECRET.encode(), (ts + '.' + body).encode(), hashlib.sha256).hexdigest()
    try:
        r = requests.post(PANEL_URL + '/api/agent/metrics', data=body, headers={
            'Content-Type': 'application/json',
            'X-Server-Id': SERVER_ID,
            'X-Timestamp': ts,
            'X-Signature': sig,
        }, timeout=5, verify=False)
        print('Sent metrics', r.status_code)
    except Exception as e:
        print('error', e)
    time.sleep(5)
