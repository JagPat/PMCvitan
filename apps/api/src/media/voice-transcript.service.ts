import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { StorageService } from './storage.service';
import { CapabilitiesService, VOICE_TEXT_CAPABILITY } from '../platform/capabilities.service';
import { isPlaceHiddenFrom } from '../nodes/node-scope';
import type { AuthUser } from '../common/auth';
import { SPEECH_PROVIDER, SpeechProviderError, type SpeechJobState, type SpeechProvider } from './speech/speech-provider';

/**
 * #1177 VT2 — a voice note's words, written out by the speech provider (AI item 1). Plan and hard choices: #1177.
 *
 * The "VoiceTranscript" row (VT1a, 20280126000000) is the durable truth of the work, and the people who view the note move
 * it on (H2): each `advance` does at most ONE step — start the provider's job, or check it — and returns the row as it
 * then stands. No timer, no queue, no in-memory retry. A note nobody opens is never sent anywhere.
 *
 * A step never calls the provider inside a transaction or under a row lock (H3). It CLAIMS the row with a short lease
 * (one UPDATE, its own statement), calls the provider outside, and writes back with an UPDATE that matches only while
 * its lease token still holds. Two viewers at once: one claims, the other reads the row as it stands. A step that dies
 * leaves a lease that expires; the next viewer carries on from the stored job id, so a second paid job is never started
 * while one is known. A note deleted meanwhile takes its row with it (ON DELETE CASCADE), the write-back matches
 * nothing, and the step ends quietly (H4). The claim's statements touch "VoiceTranscript" only and emit no event, so it
 * never holds a lock a note's delete waits on while waiting on one the delete holds (VT1a gap-check).
 *
 * Bounded tries (H6): a final provider refusal, a job the provider failed, or a third failed try marks the row
 * `failed`, and the note plays as before. A person may ask once more ("Try again"). The words heard are never
 * overwritten (the database holds V4). A person's correction is a row of its own in "VoiceTranscriptCorrection" (VT1b,
 * 20280128000000), added and never changed: the newest one is shown, attributed and timed by the database, and taking
 * a correction back is a newer row with no words (H7).
 *
 * An archived project is refused before any of this, by the route's guard (`project-access.service.ts`), as every
 * project route is.
 *
 * No event: a new event type is a new external-effect catalog generation, a migration of its own (as V1b's poster).
 * Other viewers see the words on their next read of the note.
 */

/** A claim is held this long; a step's exchanges are bounded inside it (five at most: the bucket read and four Sarvam
 *  calls, 20 s each). */
export const TRANSCRIPT_LEASE_SECONDS = 120;
/** A running job is asked about at most this often, however many people are looking at the note. */
export const TRANSCRIPT_CHECK_EVERY_SECONDS = 4;
/** After a failed try the next one waits this long, so a short outage does not use up a note's tries in a few views. */
export const TRANSCRIPT_RETRY_PAUSE_SECONDS = 20;
/** A row is marked failed on its third failed try (H6). */
export const TRANSCRIPT_MAX_ATTEMPTS = 3;
/** The database's bounds (VT1a V3, VT1b C4): the provider's words and an error are cut to fit before they are written;
 *  a correction longer than its bound is refused. */
export const TRANSCRIPT_TEXT_MAX = 20_000;
export const TRANSCRIPT_CORRECTION_MAX = 20_000;
const ERROR_MAX = 500;
const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
/** The roles that may correct any voice note's words; the member who recorded a note may correct their own. */
const CORRECTOR_ROLES = new Set(['pmc', 'engineer']);

export type TranscriptStatus = 'none' | 'pending' | 'running' | 'done' | 'failed';

export interface VoiceTranscriptDto {
  mediaId: string;
  /** `none`: nothing has been asked yet. */
  status: TranscriptStatus;
  /** The words the provider heard, when done ('' when the note held no speech). */
  text: string | null;
  languageCode: string | null;
  /** A person's correction, shown in place of `text`, with who wrote it and when. */
  correction: { text: string; byId: string; at: string } | null;
  /** The viewer may correct the words, or ask once more after a failure. */
  canCorrect: boolean;
  canRetry: boolean;
}

interface Row {
  status: string;
  providerJobId: string | null;
  text: string | null;
  languageCode: string | null;
  attempts: number;
  retried: boolean;
  /** the newest correction, if any (VT1b): its words, or null when it took the correction back */
  corrections: Array<{ text: string | null; correctedById: string; createdAt: Date }>;
}

interface Note {
  id: string;
  mime: string;
  uploadedBy: string;
  storageKey: string | null;
}

const ROW_SELECT = {
  status: true, providerJobId: true, text: true, languageCode: true, attempts: true, retried: true,
  corrections: { orderBy: { seq: 'desc' }, take: 1, select: { text: true, correctedById: true, createdAt: true } },
} as const;

@Injectable()
export class VoiceTranscriptService {
  private readonly log = new Logger('VoiceTranscriptService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly capabilities: CapabilitiesService,
    @Optional() @Inject(SPEECH_PROVIDER) private readonly provider: SpeechProvider | null,
    /** the fetch the recording is read back from the bucket with; injected for tests */
    @Optional() @Inject('VOICE_TRANSCRIPT_FETCH') private readonly http: typeof fetch = fetch,
  ) {}

  /** The note's words as they stand. Every member who can see the note reads them, where the switch is on. */
  async get(projectId: string, mediaId: string, user: AuthUser): Promise<VoiceTranscriptDto> {
    const note = await this.visibleNote(projectId, mediaId, user);
    return this.dto(note, user, await this.read(projectId, mediaId));
  }

  /** One step of the work, then the row as it stands (H2). */
  async advance(projectId: string, mediaId: string, user: AuthUser): Promise<VoiceTranscriptDto> {
    const note = await this.visibleNote(projectId, mediaId, user);
    const provider = this.provider;
    if (!provider) throw new ServiceUnavailableException('Writing out voice notes is not available right now');
    if (!(await this.read(projectId, mediaId))) await this.ensureRow(projectId, mediaId);
    const token = randomUUID();
    const claimed = await this.claim(projectId, mediaId, token);
    if (claimed) await this.step(provider, note, projectId, token, claimed);
    const row = await this.read(projectId, mediaId);
    // the note was deleted while its words were being asked for: the row went with it (H4)
    if (!row) throw new NotFoundException('Media not found');
    return this.dto(note, user, row);
  }

  /** "Try again" after a failure, once per note (H6): the row starts over, and this call takes its first step. */
  async retry(projectId: string, mediaId: string, user: AuthUser): Promise<VoiceTranscriptDto> {
    const note = await this.visibleNote(projectId, mediaId, user);
    this.assertCorrector(note, user);
    // nothing is written when the provider is not configured: the one "Try again" is kept for when it is
    if (!this.provider) throw new ServiceUnavailableException('Writing out voice notes is not available right now');
    const reset = await this.prisma.voiceTranscript.updateMany({
      where: { projectId, mediaId, status: 'failed', retried: false },
      data: { status: 'pending', providerJobId: null, attempts: 0, retried: true, lastError: null, leaseToken: null, leaseUntil: null },
    });
    if (reset.count === 0) throw new ConflictException('This voice note cannot be tried again');
    return this.advance(projectId, mediaId, user);
  }

  /** A person's correction of the words, or `null` to take it back. Only on a note whose words are written out. Each
   *  change is a new row (VT1b): the newest is shown, so two people correcting at once are both kept, in order. */
  async correct(projectId: string, mediaId: string, user: AuthUser, text: string | null): Promise<VoiceTranscriptDto> {
    const note = await this.visibleNote(projectId, mediaId, user);
    this.assertCorrector(note, user);
    const value = text === null ? null : text.trim();
    if (value !== null && value === '') throw new BadRequestException('A correction holds some words');
    if (value !== null && value.includes('\u0000')) throw new BadRequestException('A correction cannot contain that character');
    if (value !== null && Array.from(value).length > TRANSCRIPT_CORRECTION_MAX) {
      throw new BadRequestException('A correction is at most 20,000 characters');
    }
    const before = await this.read(projectId, mediaId);
    if (before?.status !== 'done') throw new ConflictException('This voice note has no words to correct yet');
    // the words already shown change nothing: the correction standing keeps its author and time
    const shown = before.corrections[0]?.text ?? null;
    if (shown !== value) {
      try {
        // the database numbers the row, stamps its time and refuses it unless the words are heard (VT1b C2, C3)
        await this.prisma.voiceTranscriptCorrection.create({ data: { projectId, mediaId, text: value, correctedById: user.sub } });
      } catch (error) {
        // the note went meanwhile (its transcript with it): answered as not found, as a deleted note is everywhere
        if (isForeignKeyViolation(error)) throw new NotFoundException('Media not found');
        throw error;
      }
    }
    return this.dto(note, user, await this.read(projectId, mediaId));
  }

  // ── the step ────────────────────────────────────────────────────────────────────────────────────────────────

  private async step(provider: SpeechProvider, note: Note, projectId: string, token: string, row: { providerJobId: string | null; attempts: number }): Promise<void> {
    try {
      if (row.providerJobId === null) {
        const audio = await this.audio(note);
        const jobId = await provider.startJob(audio, note.mime, fileName(note));
        await this.writeBack(projectId, note.id, token, { status: 'running', providerJobId: jobId.slice(0, 200), lastError: null });
        return;
      }
      const state: SpeechJobState = await provider.checkJob(row.providerJobId);
      if (state.state === 'running') {
        await this.writeBack(projectId, note.id, token, { lastError: null });
      } else if (state.state === 'done') {
        const language = languageCode(state.languageCode);
        await this.writeBack(projectId, note.id, token, { status: 'done', text: fit(state.text, TRANSCRIPT_TEXT_MAX), languageCode: language, lastError: null });
      } else {
        await this.writeBack(projectId, note.id, token, { status: 'failed', lastError: fit(state.reason, ERROR_MAX) });
      }
    } catch (error) {
      const final = error instanceof SpeechProviderError && error.final;
      const reason = fit(error instanceof SpeechProviderError ? error.message : 'The note could not be written out', ERROR_MAX);
      if (!(error instanceof SpeechProviderError)) this.log.warn(`voice note ${note.id}: ${(error as Error).message}`);
      const attempts = row.attempts + 1;
      const failed = final || attempts >= TRANSCRIPT_MAX_ATTEMPTS;
      await this.writeBack(projectId, note.id, token, failed ? { status: 'failed', attempts, lastError: reason } : { attempts, lastError: reason });
    }
  }

  /** The step's result, written only while its lease holds and the row is not done; the lease is released with it.
   *  Nothing matches once the note is gone or another step took over, and that is the end of it (H3, H4). */
  private async writeBack(projectId: string, mediaId: string, token: string, set: Prisma.VoiceTranscriptUpdateManyMutationInput): Promise<void> {
    await this.prisma.voiceTranscript.updateMany({
      where: { projectId, mediaId, leaseToken: token, status: { not: 'done' } },
      data: { ...set, leaseToken: null, leaseUntil: null },
    });
  }

  /** The row for the note, written when it is first asked for. A note deleted meanwhile is answered as not found. */
  private async ensureRow(projectId: string, mediaId: string): Promise<void> {
    try {
      await this.prisma.voiceTranscript.createMany({ data: [{ projectId, mediaId }], skipDuplicates: true });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new NotFoundException('Media not found');
      throw error;
    }
  }

  /** Take the row for one step: a pending row, or a running one not checked in the last few seconds, whose lease (if
   *  any) has run out; after a failed try, not before the pause. One statement, so two claimants cannot both win. Null
   *  when there is nothing to do now. */
  private async claim(projectId: string, mediaId: string, token: string): Promise<{ providerJobId: string | null; attempts: number } | null> {
    const now = Date.now();
    const taken = await this.prisma.voiceTranscript.updateMany({
      where: {
        projectId, mediaId,
        OR: [
          { status: 'pending', attempts: 0 },
          { status: 'running', attempts: 0, updatedAt: { lt: new Date(now - TRANSCRIPT_CHECK_EVERY_SECONDS * 1000) } },
          { status: { in: ['pending', 'running'] }, attempts: { gt: 0 }, updatedAt: { lt: new Date(now - TRANSCRIPT_RETRY_PAUSE_SECONDS * 1000) } },
        ],
        AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date(now) } }] }],
      },
      data: { leaseToken: token, leaseUntil: new Date(now + TRANSCRIPT_LEASE_SECONDS * 1000) },
    });
    if (taken.count === 0) return null;
    return this.prisma.voiceTranscript.findFirst({ where: { projectId, mediaId, leaseToken: token }, select: { providerJobId: true, attempts: true } });
  }

  // ── reads and checks ────────────────────────────────────────────────────────────────────────────────────────

  private async read(projectId: string, mediaId: string): Promise<Row | null> {
    return this.prisma.voiceTranscript.findFirst({ where: { projectId, mediaId }, select: ROW_SELECT });
  }

  /** A voice note of this project the viewer can see, where the switch is on. Anything else is answered as not found,
   *  as a file the viewer cannot see is everywhere else (a note filed on another member's private draft place). */
  private async visibleNote(projectId: string, mediaId: string, user: AuthUser): Promise<Note> {
    if (!(await this.capabilities.isEnabled(projectId, VOICE_TEXT_CAPABILITY))) throw new NotFoundException('Not found');
    const note = await this.prisma.media.findFirst({
      where: { projectId, id: mediaId },
      select: { id: true, mime: true, uploadedBy: true, storageKey: true, nodeId: true },
    });
    if (!note || !note.mime.startsWith('audio/')) throw new NotFoundException('Media not found');
    if (note.nodeId && (await this.prisma.$transaction((tx) => isPlaceHiddenFrom(tx, projectId, note.nodeId, user.sub)))) {
      throw new NotFoundException('Media not found');
    }
    return note;
  }

  private assertCorrector(note: Note, user: AuthUser): void {
    if (!CORRECTOR_ROLES.has(user.role) && note.uploadedBy !== user.sub) {
      throw new ForbiddenException('Only the person who recorded this note, the PMC or the engineer can change its words');
    }
  }

  /** The recording's bytes: the dev stub's from the row, otherwise read back from the bucket through a short-lived link. */
  private async audio(note: Note): Promise<Buffer> {
    const stored = await this.prisma.media.findUnique({ where: { id: note.id }, select: { data: true } });
    if (stored?.data) return Buffer.from(stored.data);
    const signed = note.storageKey ? await this.storage.presignGet(note.storageKey) : null;
    if (!signed) throw new Error('the recording has no stored copy');
    const res = await this.http(signed, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`the bucket answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private dto(note: Note, user: AuthUser, row: Row | null): VoiceTranscriptDto {
    const corrector = CORRECTOR_ROLES.has(user.role) || note.uploadedBy === user.sub;
    const status = (row?.status ?? 'none') as TranscriptStatus;
    return {
      mediaId: note.id,
      status,
      text: row?.status === 'done' ? row.text : null,
      languageCode: row?.status === 'done' ? row.languageCode : null,
      correction: row?.status === 'done' && row.corrections[0]?.text != null
        ? { text: row.corrections[0].text, byId: row.corrections[0].correctedById, at: row.corrections[0].createdAt.toISOString() }
        : null,
      canCorrect: corrector && status === 'done',
      canRetry: corrector && status === 'failed' && row?.retried === false,
    };
  }
}

/** The provider's language as the database keeps it, a BCP-47 code such as 'gu-IN' or 'en' (VT1a V3), whatever case
 *  the provider wrote it in; anything else is kept as no language rather than refusing the words. */
export function languageCode(value: string | null | undefined): string | null {
  const m = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}))?$/.exec((value ?? '').trim());
  if (!m) return null;
  const code = m[2] ? `${m[1]!.toLowerCase()}-${m[2].toUpperCase()}` : m[1]!.toLowerCase();
  return LANGUAGE.test(code) ? code : null;
}

/** The name the provider is given for the recording: the note's id and its container's extension. */
function fileName(note: Note): string {
  const ext = note.mime === 'audio/mp4' ? 'm4a' : note.mime === 'audio/ogg' ? 'ogg' : 'webm';
  return `${note.id}.${ext}`;
}

/** A provider value cut to the database's bound by characters (never through a surrogate pair), without NULs, which
 *  PostgreSQL text cannot hold. */
function fit(value: string, max: number): string {
  const chars = Array.from(value.replace(/\u0000/g, ''));
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

function isForeignKeyViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2003') return true;
    const meta = error.meta as { code?: string } | undefined;
    if (meta?.code === '23503') return true;
  }
  return /23503|foreign key/i.test(String((error as Error)?.message ?? ''));
}
