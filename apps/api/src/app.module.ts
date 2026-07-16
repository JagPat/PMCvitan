import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { resolveJwtSecret } from './config';
import { PrismaModule } from './prisma.module';
import { JwtGuard } from './common/auth';
import { ProjectAccessService } from './common/project-access.service';
import { CLOCK, SystemClock } from './common/clock';
import { RolesGuard } from './common/roles';
import { ThrottleGuard } from './common/throttle';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { HealthController } from './health.controller';
import { SmsService } from './auth/sms.service';
import { EmailService } from './auth/email.service';
import { GoogleAuthService } from './auth/google.service';
import { PasswordCredentialsService } from './auth/password-credentials.service';
import { SnapshotService } from './snapshot/snapshot.service';
import { ProjectController } from './snapshot/project.controller';
import { DecisionsService } from './decisions/decisions.service';
import { DecisionsController } from './decisions/decisions.controller';
import { ActivitiesService } from './activities/activities.service';
import { ActivitiesController } from './activities/activities.controller';
import { PhasesService } from './activities/phases.service';
import { PhasesController } from './activities/phases.controller';
import { InspectionsService } from './inspections/inspections.service';
import { InspectionsController } from './inspections/inspections.controller';
import { DailyLogService } from './daily-log/daily-log.service';
import { DailyLogController } from './daily-log/daily-log.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { StorageService } from './media/storage.service';
import { SignedUrlService } from './media/signed-url.service';
import { MediaService } from './media/media.service';
import { MediaController } from './media/media.controller';
import { DrawingsService } from './drawings/drawings.service';
import { NodesService } from './nodes/nodes.service';
import { NodesController } from './nodes/nodes.controller';
import { DrawingsController } from './drawings/drawings.controller';
import { PushService } from './push/push.service';
import { PushController } from './push/push.controller';
import { OrgsService } from './orgs/orgs.service';
import { OrgsController } from './orgs/orgs.controller';
import { MembersService } from './orgs/members.service';
import { MembersController } from './orgs/members.controller';
import { CompaniesService } from './orgs/companies.service';
import { CompaniesController } from './orgs/companies.controller';
import { OutboxRelay } from './platform/outbox/relay.service';
import { OutboxBootstrap } from './platform/outbox/outbox.bootstrap';
import { ModuleRegistryService } from './platform/module-registry/module-registry.service';
import { ActivityParticipant } from './activities/activity.participant';
import { InspectionParticipant } from './inspections/inspection.participant';
import { NodeInitParticipant } from './nodes/node-init.participant';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      global: true,
      // Required in production — resolveJwtSecret() throws at startup rather than
      // fall back to a public default. See config.ts.
      secret: resolveJwtSecret(),
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    ProjectController,
    DecisionsController,
    ActivitiesController,
    PhasesController,
    InspectionsController,
    DailyLogController,
    MediaController,
    DrawingsController,
    PushController,
    OrgsController,
    MembersController,
    CompaniesController,
    NodesController,
  ],
  providers: [
    JwtGuard,
    ProjectAccessService,
    { provide: CLOCK, useClass: SystemClock },
    RolesGuard,
    ThrottleGuard,
    AuthService,
    SmsService,
    EmailService,
    GoogleAuthService,
    PasswordCredentialsService,
    SnapshotService,
    DecisionsService,
    ActivitiesService,
    PhasesService,
    InspectionsService,
    DailyLogService,
    RealtimeGateway,
    StorageService,
    SignedUrlService,
    MediaService,
    DrawingsService,
    PushService,
    OrgsService,
    MembersService,
    CompaniesService,
    NodesService,
    OutboxRelay,
    OutboxBootstrap,
    ModuleRegistryService,
    // Task 7 — leaf workflow participants: each writes ONLY its owning module's tables,
    // so a cross-module atomic edge routes its foreign write through the owner (no
    // cross-module persistence write survives in the caller's service).
    ActivityParticipant,
    InspectionParticipant,
    NodeInitParticipant,
  ],
})
export class AppModule {}
