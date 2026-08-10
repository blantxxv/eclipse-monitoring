// Single source of truth for panel / agent versions.
// BUILD_HASH / BUILD_TIME are injected at deploy time via env; fall back to 'dev'.

export const BACKEND_VERSION = '2.0.0';
export const FRONTEND_VERSION = '2.0.0';

// Latest agent version the panel ships (served at /agent.py). Servers reporting
// an older version are considered outdated and offered an update.
export const AGENT_LATEST_VERSION = '1.7.1';

export const BUILD_HASH = process.env.BUILD_HASH || 'dev';
export const BUILD_TIME = process.env.BUILD_TIME || null;

// Compare two dotted version strings. Returns -1, 0, 1 (a<b, a==b, a>b).
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '0').split('.').map((x) => Number(x) || 0);
  const pb = String(b || '0').split('.').map((x) => Number(x) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export function isAgentOutdated(version?: string | null): boolean {
  if (!version) return true;
  return compareVersions(version, AGENT_LATEST_VERSION) < 0;
}
