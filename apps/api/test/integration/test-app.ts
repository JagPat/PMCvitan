import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app-setup';
import { PrismaService } from '../../src/prisma.service';
import type { Role } from '../../src/common/auth';

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
export async function createTestApp(): Promise<TestApp> {
  if (!process.env.DATABASE_URL?.includes('test')) {
    throw new Error('Refusing to run integration tests: DATABASE_URL must point at a disposable *test* database');
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
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
