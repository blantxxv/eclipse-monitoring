import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AlertsService } from './alerts.service';

@Controller('api/alerts') @UseGuards(JwtAuthGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}
  @Get() list(@Query('limit') limit?: string, @Query('offset') offset?: string) { return this.alerts.recent(Number(limit) || 10, Number(offset) || 0); }
}
