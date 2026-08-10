import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateServerInput, ServersService } from './servers.service';
@Controller('api/servers') @UseGuards(JwtAuthGuard)
export class ServersController {
  constructor(private readonly servers: ServersService) {}
  @Get() list() { return this.servers.list(); }
  @Put('order') reorder(@Body() body: { ids: string[] }) { return this.servers.reorder(body?.ids || []); }
  @Post('poweroff') poweroff(@Body() body: { categories: string[] }) { return this.servers.poweroffByCategories(body?.categories || []); }
  @Post() create(@Body() body: CreateServerInput) { return this.servers.create(body); }
  @Put(':id') update(@Param('id') id: string, @Body() body: { name?: string; description?: string; ip?: string; port?: number; category?: string; country?: string | null; tags?: string[] }) { return this.servers.update(id, body || {}); }
  @Get(':id') get(@Param('id') id: string) { return this.servers.get(id); }
  @Post(':id/regenerate-token') regenerate(@Param('id') id: string) { return this.servers.regenerateToken(id); }
  @Post(':id/revoke-agent') revoke(@Param('id') id: string) { return this.servers.revoke(id); }
  @Delete(':id') delete(@Param('id') id: string) { return this.servers.delete(id); }
  @Get(':id/metrics/latest') latest(@Param('id') id: string) { return this.servers.latestMetrics(id); }
  @Get(':id/metrics/history') history(@Param('id') id: string, @Query('range') range: string) { return this.servers.metricsHistory(id, range || '1h'); }
  @Post(':id/command') command(@Param('id') id: string, @Body() body: { command: string; payload?: any }) { return this.servers.queueCommand(id, String(body?.command || ''), body?.payload); }
  @Get(':id/commands') commands(@Param('id') id: string) { return this.servers.listCommands(id); }
  @Get(':id/logs') logs(@Param('id') id: string) { return this.servers.getAgentLogs(id); }
  @Post(':id/category') category(@Param('id') id: string, @Body() body: { category: string }) { return this.servers.setCategory(id, String(body?.category || 'other')); }
}
