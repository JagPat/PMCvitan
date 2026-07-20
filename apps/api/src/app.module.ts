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
import { DecisionsQueryService } from './decisions/decisions.query';
import { DecisionsController } from './decisions/decisions.controller';
import { ActivitiesService } from './activities/activities.service';
import { ActivitiesQueryService } from './activities/activities.query';
import { ActivitiesController } from './activities/activities.controller';
import { PhasesService } from './activities/phases.service';
import { PhasesController } from './activities/phases.controller';
import { RequirementsController } from './activities/requirements.controller';
import { RequirementsService } from './activities/requirements.service';
import { CapabilitiesService } from './platform/capabilities.service';
import { InspectionsService } from './inspections/inspections.service';
import { InspectionsQueryService } from './inspections/inspections.query';
import { InspectionsController } from './inspections/inspections.controller';
import { DailyLogService } from './daily-log/daily-log.service';
import { DailyLogQueryService } from './daily-log/daily-log.query';
import { DailyLogController } from './daily-log/daily-log.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { StorageService } from './media/storage.service';
import { SignedUrlService } from './media/signed-url.service';
import { MediaService } from './media/media.service';
import { MediaController } from './media/media.controller';
import { DrawingsService } from './drawings/drawings.service';
import { DrawingsQueryService } from './drawings/drawings.query';
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
import { ExternalEffectDispatcher } from './platform/outbox/external-effect-dispatcher';
import { OutboxBootstrap } from './platform/outbox/outbox.bootstrap';
import { OutboxOperationsService } from './platform/outbox/outbox-operations.service';
import { ProjectionRebuilder } from './platform/projections/rebuilder.service';
import { ModuleRegistryService } from './platform/module-registry/module-registry.service';
import { ActivityParticipant } from './activities/activity.participant';
import { InspectionParticipant } from './inspections/inspection.participant';
import { NodeInitParticipant } from './nodes/node-init.participant';
import { DrawingParticipant } from './drawings/drawing.participant';
import { DailyLogParticipant } from './daily-log/daily-log.participant';

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
    RequirementsController,
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
    RequirementsService,
    CapabilitiesService,
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
    // Task 8 — the decisions module's public READ boundary; every other module's decision read goes
    // through this query provider, never `prisma.decision` directly (the module owns its repository).
    DecisionsQueryService,
    ActivitiesService,
    // Task 10 (Module 4) — the activities module's public READ boundary (snapshot spine slices with
    // fresh-baked readiness + projection read + init/copy structures + portfolio rollup).
    ActivitiesQueryService,
    PhasesService,
    InspectionsService,
    // Task 10 (Module 3) — the inspections module's public READ boundary (snapshot slices + readiness
    // input + projection read + tenant-ref check).
    InspectionsQueryService,
    DailyLogService,
    // Task 10 — the daily-log module's public READ boundary (snapshot slice + tenant-ref check).
    DailyLogQueryService,
    RealtimeGateway,
    StorageService,
    SignedUrlService,
    MediaService,
    DrawingsService,
    DrawingsQueryService,
    PushService,
    OrgsService,
    MembersService,
    CompaniesService,
    NodesService,
    OutboxRelay,
    // PR C Task 2 — the single external-effect sender (legacy/shadow immediate dispatch);
    // depends on OutboxRelay for the shared claim/dispatch/failure path.
    ExternalEffectDispatcher,
    OutboxBootstrap,
    OutboxOperationsService,
    // Task 9 — the projection rebuild + final-activation-barrier protocol (generation swap).
    ProjectionRebuilder,
    ModuleRegistryService,
    // Task 7 — leaf workflow participants: each writes ONLY its owning module's tables,
    // so a cross-module atomic edge routes its foreign write through the owner (no
    // cross-module persistence write survives in the caller's service).
    ActivityParticipant,
    InspectionParticipant,
    NodeInitParticipant,
    // Module 4 correction — owner-aligned signals for ON DELETE SET NULL columns
    // serialized into module projections (drawings.inbox, daily-log.inbox).
    DrawingParticipant,
    DailyLogParticipant,
  ],
})
export class AppModule {}
