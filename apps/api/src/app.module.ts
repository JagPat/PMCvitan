import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from './prisma.module';
import { JwtGuard } from './common/auth';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { SmsService } from './auth/sms.service';
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
import { StorageService } from './media/storage.service';
import { MediaService } from './media/media.service';
import { MediaController } from './media/media.controller';

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
    MediaController,
  ],
  providers: [
    JwtGuard,
    AuthService,
    SmsService,
    SnapshotService,
    DecisionsService,
    ActivitiesService,
    InspectionsService,
    DailyLogService,
    RealtimeGateway,
    StorageService,
    MediaService,
  ],
})
export class AppModule {}
