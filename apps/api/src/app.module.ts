import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from './prisma.module';
import { JwtGuard } from './common/auth';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { SmsService } from './auth/sms.service';
import { EmailService } from './auth/email.service';
import { GoogleAuthService } from './auth/google.service';
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
import { DrawingsService } from './drawings/drawings.service';
import { DrawingsController } from './drawings/drawings.controller';
import { PushService } from './push/push.service';
import { PushController } from './push/push.controller';
import { OrgsService } from './orgs/orgs.service';
import { OrgsController } from './orgs/orgs.controller';

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
    DrawingsController,
    PushController,
    OrgsController,
  ],
  providers: [
    JwtGuard,
    AuthService,
    SmsService,
    EmailService,
    GoogleAuthService,
    SnapshotService,
    DecisionsService,
    ActivitiesService,
    InspectionsService,
    DailyLogService,
    RealtimeGateway,
    StorageService,
    MediaService,
    DrawingsService,
    PushService,
    OrgsService,
  ],
})
export class AppModule {}
