import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, VOICE_TEXT_CAPABILITY } from '../platform/capabilities.service';
import { NodesQueryService } from '../nodes/nodes.query';
import type { AuthUser } from '../common/auth';
import { resolveActor, type Actor } from '../common/actor';
import { lockActorStanding, resolveActorEnvelope } from '../platform/actor-envelope';
import { lockProjectTreeShared } from '../common/tree-lock';
import { SPEECH_PROVIDER, type SpeechProvider } from './speech/speech-provider';

/**
 * #1177 VT2-C1 — a voice note's words (AI item 1): read them, correct them, and ask once more after a failure. Plan and
 * hard choices: #1177; the redesign after #1226's third-head stop: notes/ai/voice-text/vt2/redesign-plan.md.
 *
 * The "VoiceTranscript" row (VT1a, 20280126000000) is the durable truth of the work. The step that writes a note's words
 * out through the speech provider (`POST …/transcript`) is VT2-C2's, under the fence Jagrut approved; this unit sends
 * nothing anywhere and never calls the provider. It needs one configured all the same: without a provider every route
 * here answers 503 and writes nothing, so "Try again" is kept for when one is (H6).
 *
 * Bounded tries (H6): a person may ask once more after a failure ("Try again"), which starts the row over; the next
 * step (C2) takes it from there. The words heard are never overwritten (the database holds V4). A person's correction
 * is a row of its own in "VoiceTranscriptCorrection" (VT1b, 20280128000000), added and never changed: the newest one is
 * shown, attributed and timed by the database, and taking a correction back is a newer row with no words (H7).
 *
 * An archived project is refused by the route's guard (`project-access.service.ts`), as every project route is, and a
 * write asks again under lock inside its transaction (`lockForWrite`). A note on a place hidden from the viewer is
 * answered as not found, through the nodes module's query contract (VT2-B), never a read of its tables.
 *
 * No event: a new event type is a new external-effect catalog generation, a migration of its own (as V1b's poster).
 * Other viewers see the words on their next read of the note.
 */

/** The database's bound on a correction (VT1b C4): a longer one is refused. */
export const TRANSCRIPT_CORRECTION_MAX = 20_000;
/** A half of a surrogate pair standing alone: no character at all, and PostgreSQL's UTF-8 text cannot hold it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Only spaces and what shows nothing: format characters (U+200B, U+FEFF, a joiner), marks with no letter to sit on
 *  (a lone combining mark, a variation selector), and the blank letters (Hangul fillers, the blank Braille pattern). */
const BLANK = /^[\p{White_Space}\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u2800\u3164\uFFA0]*$/u;
/** READ COMMITTED, as the database requires of a correction (VT1b C3), so each statement after a lock sees what
 *  committed before it. */
const WRITE_TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 30_000 };
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
  /** The place of the newest correction (0: none yet, VT1b's `seq`). A correction names the one it was made on. */
  correctionSeq: number;
  /** The viewer may correct the words, or ask once more after a failure. */
  canCorrect: boolean;
  canRetry: boolean;
}

interface Row {
  status: string;
  text: string | null;
  languageCode: string | null;
  attempts: number;
  retried: boolean;
  /** the newest correction, if any (VT1b): its words, or null when it took the correction back */
  corrections: Array<{ seq: number; text: string | null; correctedById: string; createdAt: Date }>;
}

interface Note {
  id: string;
  mime: string;
  uploadedBy: string;
}

const ROW_SELECT = {
  status: true, text: true, languageCode: true, attempts: true, retried: true,
  corrections: { orderBy: { seq: 'desc' }, take: 1, select: { seq: true, text: true, correctedById: true, createdAt: true } },
} as const;

@Injectable()
export class VoiceTranscriptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly nodes: NodesQueryService,
    /** never called here (VT2-C2 makes the exchanges); its absence closes the feature */
    @Optional() @Inject(SPEECH_PROVIDER) private readonly provider: SpeechProvider | null,
  ) {}

  /** The note's words as they stand. Every member who can see the note reads them, where the switch is on. */
  async get(projectId: string, mediaId: string, user: AuthUser): Promise<VoiceTranscriptDto> {
    const note = await this.visibleNote(projectId, mediaId, user);
    this.configured();
    return this.dto(note, user, await this.read(projectId, mediaId));
  }

  /** "Try again" after a failure, once per note (H6): the row starts over as pending, with no job and no tries spent;
   *  the next step (VT2-C2) takes it from there. Asked again once it has started over (a lost answer sent again, or a
   *  second person at the same moment), it answers as the first did and writes nothing; once it has failed again, there
   *  is no try left (409). */
  async retry(projectId: string, mediaId: string, user: AuthUser): Promise<VoiceTranscriptDto> {
    const note = await this.visibleNote(projectId, mediaId, user);
    // nothing is written when the provider is not configured: the one "Try again" is kept for when it is
    this.configured();
    this.assertCorrector(note, user);
    const actor = await resolveActor(this.prisma, user);
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockForWrite(tx, projectId, mediaId, user, actor);
      if (row?.retried === true && row.status !== 'failed') return;
      if (row?.status !== 'failed' || row.retried) throw new ConflictException('This voice note cannot be tried again');
      await tx.voiceTranscript.update({
        where: { mediaId },
        data: { status: 'pending', providerJobId: null, attempts: 0, retried: true, lastError: null, leaseToken: null, leaseUntil: null },
      });
    }, WRITE_TX);
    const row = await this.read(projectId, mediaId);
    // the note was deleted just now: its row went with it (H4)
    if (!row) throw new NotFoundException('Media not found');
    return this.dto(note, user, row);
  }

  /** A person's correction of the words, or `null` to take it back, made on the correction `basedOn` (its place; 0 when
   *  there was none). Only on a note whose words are written out. Each change is a new row (VT1b): the newest is shown.
   *  A correction made on words someone else has changed since is refused, so a screen left open never silently
   *  replaces a newer correction it did not show. The same correction sent again by its author (a lost answer) finds
   *  itself the newest and answers as the first did, writing nothing. */
  async correct(projectId: string, mediaId: string, user: AuthUser, text: string | null, basedOn: number): Promise<VoiceTranscriptDto> {
    const note = await this.visibleNote(projectId, mediaId, user);
    this.configured();
    this.assertCorrector(note, user);
    const value = text === null ? null : text.trim();
    // only spaces and invisible marks (a zero-width space, a byte-order mark) would show as empty words with an author
    if (value !== null && BLANK.test(value)) throw new BadRequestException('A correction holds some words');
    if (value !== null && (value.includes('\u0000') || LONE_SURROGATE.test(value))) {
      throw new BadRequestException('A correction cannot contain that character');
    }
    if (value !== null && Array.from(value).length > TRANSCRIPT_CORRECTION_MAX) {
      throw new BadRequestException('A correction is at most 20,000 characters');
    }
    const actor = await resolveActor(this.prisma, user);
    await this.prisma.$transaction(async (tx) => {
      const heard = await this.lockForWrite(tx, projectId, mediaId, user, actor);
      if (heard?.status !== 'done') throw new ConflictException('This voice note has no words to correct yet');
      const newest = await tx.voiceTranscriptCorrection.findFirst({
        where: { projectId, mediaId }, orderBy: { seq: 'desc' }, select: { seq: true, text: true, correctedById: true },
      });
      // this very correction, sent again: it is the newest, made on the one this person saw
      if (newest && newest.seq === basedOn + 1 && newest.correctedById === user.sub && newest.text === value) return;
      if ((newest?.seq ?? 0) !== basedOn) throw new ConflictException('Someone else changed these words just now');
      // the words already shown change nothing: the correction standing (or the words heard) keeps its author and time
      const standing = newest?.text ?? null;
      if (value === null ? standing === null : value === (standing ?? heard.text?.trim())) return;
      // the database numbers the row and stamps its time (VT1b C2, C3)
      await tx.voiceTranscriptCorrection.create({ data: { projectId, mediaId, text: value, correctedById: user.sub } });
    }, WRITE_TX);
    const after = await this.read(projectId, mediaId);
    if (!after) throw new NotFoundException('Media not found');
    return this.dto(note, user, after);
  }

  /**
   * Everything a write was let through on, asked again under lock inside its transaction, so nothing that changed since
   * the request began (an archive, a removal from the project, a change of role, the switch turned off, the place
   * hidden, the note deleted) is written through. Then the transcript row, locked as VT1b's insert trigger locks it.
   *
   * The lock order:
   * - the place tree's shared side FIRST, as `tree-lock.ts` asks of every write that reads the tree's visibility. A
   *   node's delete, and a file's removal from its visit, take the tree before the note's row, so taking the note's row
   *   first would deadlock with them (gap-check, round 2);
   * - then the note's row: every delete of a note takes its row first and its transcript with it, so a delete is wholly
   *   before or after this;
   * - then the person's standing and the project's row (`phase6_project_operable`), as `MediaService.addPoster` takes
   *   them after the note's row. The switch is read after the project's row, which turning it off or on also takes
   *   first (`capability-switch.ts`);
   * - last, the transcript row, as VT1b's insert trigger takes it.
   * Returns null when the note has no transcript row.
   */
  private async lockForWrite(tx: Prisma.TransactionClient, projectId: string, mediaId: string, user: AuthUser, actor: Actor): Promise<{ status: string; text: string | null; retried: boolean } | null> {
    await lockProjectTreeShared(tx, projectId);
    const [media] = await tx.$queryRaw<Array<{ nodeId: string | null }>>(Prisma.sql`
      SELECT "nodeId" FROM "Media" WHERE "projectId" = ${projectId} AND "id" = ${mediaId} FOR NO KEY UPDATE`);
    if (!media) throw new NotFoundException('Media not found');
    await lockActorStanding(tx, projectId, user.sub);
    const [state] = await tx.$queryRaw<Array<{ operable: boolean }>>(Prisma.sql`SELECT phase6_project_operable(${projectId}) AS "operable"`);
    if (state?.operable !== true) throw new ForbiddenException('Project is unavailable');
    if (!(await resolveActorEnvelope(tx, projectId, actor))) throw new ForbiddenException('Your role on this project has changed; sign in again');
    if (!(await this.capabilities.isEnabled(projectId, VOICE_TEXT_CAPABILITY, tx))) throw new NotFoundException('Not found');
    if (media.nodeId && (await this.nodes.placeHiddenFrom(tx, projectId, media.nodeId, user.sub))) throw new NotFoundException('Media not found');
    const [row] = await tx.$queryRaw<Array<{ status: string; text: string | null; retried: boolean }>>(Prisma.sql`
      SELECT v."status", v."text", v."retried" FROM public."VoiceTranscript" v
       WHERE v."projectId" = ${projectId} AND v."mediaId" = ${mediaId} FOR NO KEY UPDATE`);
    return row ?? null;
  }

  // ── reads and checks ────────────────────────────────────────────────────────────────────────────────────────

  /** 503 when no provider is configured: then no route reads or writes anything (H6). */
  private configured(): void {
    if (!this.provider) throw new ServiceUnavailableException('Writing out voice notes is not available right now');
  }

  private async read(projectId: string, mediaId: string): Promise<Row | null> {
    return this.prisma.voiceTranscript.findFirst({ where: { projectId, mediaId }, select: ROW_SELECT });
  }

  /** A voice note of this project the viewer can see, where the switch is on. Anything else is answered as not found,
   *  as a file the viewer cannot see is everywhere else (a note filed on another member's private draft place). */
  private async visibleNote(projectId: string, mediaId: string, user: AuthUser): Promise<Note> {
    if (!(await this.capabilities.isEnabled(projectId, VOICE_TEXT_CAPABILITY))) throw new NotFoundException('Not found');
    const note = await this.prisma.media.findFirst({
      where: { projectId, id: mediaId },
      select: { id: true, mime: true, uploadedBy: true, nodeId: true },
    });
    if (!note || !note.mime.startsWith('audio/')) throw new NotFoundException('Media not found');
    if (note.nodeId && (await this.prisma.$transaction((tx) => this.nodes.placeHiddenFrom(tx, projectId, note.nodeId, user.sub)))) {
      throw new NotFoundException('Media not found');
    }
    return note;
  }

  private assertCorrector(note: Note, user: AuthUser): void {
    if (!CORRECTOR_ROLES.has(user.role) && note.uploadedBy !== user.sub) {
      throw new ForbiddenException('Only the person who recorded this note, the PMC or the engineer can change its words');
    }
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
      correctionSeq: row?.corrections[0]?.seq ?? 0,
      canCorrect: corrector && status === 'done',
      canRetry: corrector && status === 'failed' && row?.retried === false,
    };
  }
}

