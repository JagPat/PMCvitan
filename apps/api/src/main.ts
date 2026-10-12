import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app-setup';
import { OutboxBootstrap } from './platform/outbox/outbox.bootstrap';
import { listenPort } from './listen-port';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const port = listenPort();
  await app.listen(port);
  // 4d-ii-a / A6e — the process is now actually serving: release the server-generation admission
  // the outbox bootstrap held through boot (the row's SHARE lock), so a raising migration that
  // waited behind this start may proceed. See `src/platform/server-generation.ts`.
  app.get(OutboxBootstrap).releaseAdmission();
  // eslint-disable-next-line no-console
  console.log(`Vitan PMC API listening on :${port}`);
}

void bootstrap();
