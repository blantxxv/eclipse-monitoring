import { BadRequestException, Body, Controller, Headers, Post } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { SecurityService } from './security.service';

@Controller('api/telegram')
export class TelegramWebhookController {
  constructor(private readonly settings: SettingsService, private readonly security: SecurityService) {}

  @Post('webhook')
  async webhook(@Body() body: any, @Headers('x-telegram-bot-api-secret-token') secretHeader: string) {
    const expected = await this.settings.getWebhookSecret();
    if (!secretHeader || secretHeader !== expected) throw new BadRequestException('invalid secret');
    await this.security.handleWebhookUpdate(body);
    return { ok: true };
  }
}
