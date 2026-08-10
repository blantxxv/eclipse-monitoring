import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SettingsService } from './settings.service';

@Controller('api/settings') @UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}
  @Get() get() { return this.settings.getPublic(); }
  @Post('telegram/token') setToken(@Body() body: { token: string }) { return this.settings.setTelegramToken(body?.token); }
  @Delete('telegram/token') clearToken() { return this.settings.clearTelegramToken(); }
  @Post('telegram/chat-ids') addChatId(@Body() body: { id: string }) { return this.settings.addChatId(body?.id); }
  @Delete('telegram/chat-ids/:id') removeChatId(@Param('id') id: string) { return this.settings.removeChatId(id); }
  @Put('thresholds') thresholds(@Body() body: any) { return this.settings.updateThresholds(body || {}); }
}
