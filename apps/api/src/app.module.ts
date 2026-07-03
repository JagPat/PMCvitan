import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from './prisma.module';
import { JwtGuard } from './common/auth';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { SnapshotService } from './snapshot/snapshot.service';
import { ProjectController } from './snapshot/project.controller';
import { DecisionsService } from './decisions/decisions.service';
import { DecisionsController } from './decisions/decisions.controller';
import { ActivitiesService } from './activities/activities.service';
import { ActivitiesController } from './activities/activities.controller';
import { InspectionsService } from './inspections/inspections.service';
import { InspectionsController } from './inspections/inspections.controller';
import { DailyLogService } from './daily-log/daily-log.service';
import { DailyLogController } from './daily-log/daily-log.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'dev-secret-change-in-prod',
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [
    AuthController,
    ProjectController,
    DecisionsController,
    ActivitiesController,
    InspectionsController,
    DailyLogController,
  ],
  providers: [
    JwtGuard,
    AuthService,
    SnapshotService,
    DecisionsService,
    ActivitiesService,
    InspectionsService,
    DailyLogService,
    RealtimeGateway,
  ],
})
export class AppModule {}
