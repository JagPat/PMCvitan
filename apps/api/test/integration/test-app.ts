import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app-setup';
import { PrismaService } from '../../src/prisma.service';
import type { Role } from '../../src/common/auth';
import { EmailService } from '../../src/platform/email.service';
import { OutboxBootstrap } from '../../src/platform/outbox/outbox.bootstrap';
import { SPEECH_PROVIDER, type SpeechProvider } from '../../src/media/speech/speech-provider';

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  /** Sign a project-scoped token exactly as POST /auth/* would. */
  issueProjectToken: (sub: string, projectId: string, role?: Role) => string;
  /** Sign an org-owner token (a PMC operating an org project without a membership). */
  issueOrgOwnerToken: (sub: string, projectId: string, orgId: string) => string;
  close: () => Promise<void>;
}

/**
 * Boots the REAL application (full AppModule — every controller, guard and
 * service) against the REAL database in DATABASE_URL, configured exactly like
 * production via the shared configureApp(). Nothing is mocked.
 */
export interface TestAppOptions {
  capturePasswordCode?: (email: string, code: string) => void;
  /** #827 — mail is "configured" and phone sign-in codes are captured here instead of sent (throw to fail a send). */
  capturePhoneCode?: (email: string, code: string) => void;
  /** #1177 VT2 — the speech provider a voice note's words are asked of (a fake; production's is Sarvam, when keyed). */
  speechProvider?: SpeechProvider;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  if (!process.env.DATABASE_URL?.includes('test')) {
    throw new Error('Refusing to run integration tests: DATABASE_URL must point at a disposable *test* database');
  }
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.capturePasswordCode || options.capturePhoneCode) {
    const email = new EmailService();
    if (options.capturePasswordCode) {
      email.sendPasswordCredentialCode = async (address, code) => {
        options.capturePasswordCode!(address, code);
        return { live: true };
      };
    }
    if (options.capturePhoneCode) {
      // the real `sendPhoneSignInCode` runs (its 503 on a failed hand-over included); only the transport is replaced
      Object.defineProperty(email, 'configured', { get: () => true });
      (email as unknown as { tx: () => unknown }).tx = () => ({
        sendMail: async (mail: { to: string; subject: string; text: string }) => {
          const code = /sign-in code is (\d+)/.exec(mail.text)?.[1];
          if (code) options.capturePhoneCode!(mail.to, code);
        },
      });
    }
    builder.overrideProvider(EmailService).useValue(email);
  }
  if (options.speechProvider) builder.overrideProvider(SPEECH_PROVIDER).useValue(options.speechProvider);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  // #1210 residual — given a server that is not listening, supertest listens for the first request and
  // closes the shared server when THAT request ends, so a concurrent request still connecting is refused
  // or reset and never reaches the app. Listening here first means no request owns the server. This is
  // the raw http server's listen, which skips Nest's listen hooks. `app.close()` closes it.
  const server = app.getHttpServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    // the caller never gets this app to close, so close it here: the admission (released on module
    // destroy) and the pool must not outlive a failed boot
    const pool = app.get(PrismaService);
    await app.close();
    await pool.$disconnect();
    throw error;
  }
  // 4d-ii-a / A6e — the harness never calls `app.listen()`; the process serves once its listener above
  // is open, so release the server-generation admission `OutboxBootstrap` held through boot only now, as
  // `main.ts` does after `app.listen()`, or the row's SHARE lock would outlive the suite's boot.
  app.get(OutboxBootstrap).releaseAdmission();
  const prisma = app.get(PrismaService);
  const jwt = app.get(JwtService);
  return {
    app,
    prisma,
    issueProjectToken: (sub, projectId, role = 'pmc') => jwt.sign({ sub, role, projectId }),
    issueOrgOwnerToken: (sub, projectId, orgId) => jwt.sign({ sub, role: 'pmc', projectId, orgId }),
    close: async () => {
      await app.close();
      await prisma.$disconnect(); // PrismaService has no onModuleDestroy — disconnect explicitly
    },
  };
}
