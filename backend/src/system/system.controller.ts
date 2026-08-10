import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AGENT_LATEST_VERSION, BACKEND_VERSION, FRONTEND_VERSION, BUILD_HASH, BUILD_TIME } from '../common/version';

// Обновлением панели занимается хостовый скрипт (scripts/self-update.sh), запускаемый systemd.
// Бэкенд только кладёт файл-заявку в общий каталог и читает состояние: так GitHub-токен
// и доступ к docker остаются вне контейнера.
const STATE_DIR = process.env.UPDATE_STATE_DIR || '/var/eclipse-update';

type UpdateState = {
  status?: string;
  message?: string;
  local?: string;
  localShort?: string;
  remote?: string;
  remoteShort?: string;
  behind?: number;
  updateAvailable?: boolean;
  latestSubject?: string;
  checkedAt?: string;
  currentBranch?: string;
};

@Controller('api/system') @UseGuards(JwtAuthGuard)
export class SystemController {
  private async readState(): Promise<UpdateState | null> {
    try {
      return JSON.parse(await fs.readFile(join(STATE_DIR, 'state.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  private async request(kind: 'check' | 'apply') {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      await fs.writeFile(join(STATE_DIR, `${kind}.request`), new Date().toISOString());
      return { ok: true, queued: kind };
    } catch (e: any) {
      // Каталог не примонтирован — значит панель поставлена не установщиком.
      return { ok: false, error: 'update_channel_unavailable', detail: String(e?.message || e) };
    }
  }

  @Get('update') async update() {
    const state = await this.readState();
    return {
      versions: {
        backend: BACKEND_VERSION,
        frontend: FRONTEND_VERSION,
        agentLatest: AGENT_LATEST_VERSION,
        buildHash: BUILD_HASH,
        buildTime: BUILD_TIME,
      },
      // channelReady=false — панель развёрнута вручную, кнопки обновления смысла не имеют
      channelReady: state !== null,
      state: state || null,
    };
  }

  @Post('update/check') check() { return this.request('check'); }
  @Post('update/apply') apply() { return this.request('apply'); }

  @Get('update/log') async log() {
    try {
      const text = await fs.readFile(join(STATE_DIR, 'update.log'), 'utf8');
      return { log: text.split('\n').slice(-200).join('\n') };
    } catch {
      return { log: null };
    }
  }
}
