import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Decision } from '@vitan/shared';
import { useStore } from '../store/store';

/**
 * Phase 6 unit 4c-ii (§A/§J) — the consultation thread on one decision.
 *
 * A consultation INFORMS and never GATES, so nothing here moves a status, a gate or an approval:
 * the panel shows what was asked and what came back, and offers the two acts the server accepts.
 *
 * CAPABILITY-GATED, exactly as the write surface and the emitter are (§D). The gate is a rollout
 * latch, not a pilot: until an operator turns `consultation` on for this project — after the
 * drain-first cutover — this renders NOTHING. Controls whose every request returns a deterministic
 * 404 are not a byte-identical gate-off state, they are a visibly broken one, so the client reads
 * the same per-project capability the server does. That read RETIRES in 4c-iv together with the
 * server-side ones: the gate goes in one place, not two.
 */
export function ConsultationPanel({ d }: { d: Decision }) {
  const enabled = useStore((s) => s.capabilities.includes('consultation'));
  const role = useStore((s) => s.role);
  const sessionUserId = useStore((s) => s.sessionUserId);
  const members = useStore(useShallow((s) => s.members));
  const requestConsultation = useStore((s) => s.requestConsultation);
  const respondToConsultation = useStore((s) => s.respondToConsultation);

  const thread = d.consultations ?? [];
  // Advice belongs only to a published, still-open decision — the same window the command and the
  // database seal enforce. Showing the form on a settled decision would offer an act that 409s.
  const open = !d.draft && (d.status === 'pending' || d.status === 'change');
  // ASKING is the practice's act (`decision.consult` is pmc-only), so the form appears for the
  // role the server would accept and nobody else.
  const mayAsk = enabled && open && role === 'pmc';
  // ANSWERING belongs to the ONE named consultee, and only while their consultation is unanswered.
  const mine = thread.find((c) => !!sessionUserId && c.consulteeUserId === sessionUserId && !c.response);
  const mayAnswer = enabled && open && !!mine;

  if (!enabled || (thread.length === 0 && !mayAsk)) return null;

  return (
    <div style={{ borderTop: '1px solid #E7E3DA', marginTop: 10, paddingTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#6B665C', marginBottom: 6 }}>Advice</div>
      {thread.map((c) => (
        <ConsultationRow key={c.id} c={c} d={d} isMine={c.id === mine?.id} />
      ))}
      {mayAnswer && mine && (
        <ReplyForm
          options={d.options.map((o) => ({ key: o.key, label: o.label }))}
          onSubmit={(answer, optionKey) => respondToConsultation(d.id, mine.id, answer, optionKey)}
        />
      )}
      {mayAsk && (
        <AskForm
          // Only ACTIVE members can be asked, and only ones the thread has not already asked in
          // this cycle — re-asking the same person the same open question is not a second act.
          candidates={members
            .filter((m) => m.status === 'active' && !!m.membershipId)
            .filter((m) => !thread.some((c) => c.consulteeMembershipId === m.membershipId && !c.response))}
          onSubmit={(membershipId, question) => requestConsultation(d.id, membershipId, question)}
        />
      )}
    </div>
  );
}

/** One consultation: what was asked, by whom, and the answer when it has come. An UNANSWERED one
 *  carries its AGE — that is the §D disclosed bound made visible. A consultee's tab may be stale
 *  and push is best-effort, so an unanswered question can sit unseen; nothing is lost and nothing
 *  is blocked, but the person who asked is the one who can follow it up by other means, and they
 *  can only do that if they can see that it is still waiting. */
function ConsultationRow({ c, d, isMine }: { c: NonNullable<Decision['consultations']>[number]; d: Decision; isMine: boolean }) {
  const members = useStore(useShallow((s) => s.members));
  const nameOf = (userId: string) => members.find((m) => m.userId === userId)?.name ?? 'a team member';
  const recommended = c.response?.recommendedOptionKey
    ? d.options.find((o) => o.key === c.response!.recommendedOptionKey)?.label
    : undefined;
  return (
    <div style={{ marginBottom: 8, fontSize: 13 }}>
      <div style={{ color: '#3A362E' }}>
        <strong>{nameOf(c.consulteeUserId)}</strong>
        {isMine ? ' (you)' : ''} — asked by {nameOf(c.requestedById)}
      </div>
      <div style={{ color: '#6B665C', marginTop: 2 }}>{c.question}</div>
      {c.response ? (
        <div style={{ marginTop: 4, paddingLeft: 10, borderLeft: '2px solid #C8C2B4' }}>
          <div style={{ color: '#3A362E' }}>{c.response.response}</div>
          {recommended && (
            <div style={{ color: '#6B665C', fontSize: 12, marginTop: 2 }}>Suggests: {recommended}</div>
          )}
        </div>
      ) : (
        <div style={{ color: '#8A8478', fontSize: 12, marginTop: 2 }}>Awaiting reply — {ageLabel(c.requestedAt)}</div>
      )}
    </div>
  );
}

/** Whole days since the question was asked, in the plain language the rest of the app uses.
 *  Module-local: exporting a non-component from a component file breaks fast refresh, and this
 *  has exactly one caller. */
function ageLabel(requestedAt: string): string {
  const days = Math.floor((Date.now() - new Date(requestedAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return 'asked today';
  return days === 1 ? 'asked yesterday' : `asked ${days} days ago`;
}

function AskForm({
  candidates,
  onSubmit,
}: {
  candidates: Array<{ membershipId?: string; name: string; role: string }>;
  onSubmit: (membershipId: string, question: string) => void;
}) {
  const [membershipId, setMembershipId] = useState('');
  const [question, setQuestion] = useState('');
  // Submitting CLEARS the form, which makes `ready` false and disables the button — that is the
  // double-click guard, and it is a real one rather than a latch that toggles back in the same
  // tick. Exactly-once is the durable outbox's job, under the key the store mints per action.
  const ready = !!membershipId && question.trim().length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
      <select value={membershipId} onChange={(e) => setMembershipId(e.target.value)} aria-label="Who to ask">
        <option value="">Ask someone…</option>
        {candidates.map((m) => (
          <option key={m.membershipId} value={m.membershipId}>
            {m.name} ({m.role})
          </option>
        ))}
      </select>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="What do you need their view on?"
        aria-label="Question"
        rows={2}
      />
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          onSubmit(membershipId, question);
          setMembershipId('');
          setQuestion('');
        }}
      >
        Ask for advice
      </button>
    </div>
  );
}

function ReplyForm({
  options,
  onSubmit,
}: {
  options: Array<{ key: string; label: string }>;
  onSubmit: (response: string, recommendedOptionKey?: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [optionKey, setOptionKey] = useState('');
  const ready = answer.trim().length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Your view"
        aria-label="Your reply"
        rows={2}
      />
      {/* naming an option is ADVICE — it recommends, it does not choose; the decider still decides */}
      <select value={optionKey} onChange={(e) => setOptionKey(e.target.value)} aria-label="Suggest an option">
        <option value="">No particular option</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            Suggest: {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          onSubmit(answer, optionKey || undefined);
          setAnswer('');
          setOptionKey('');
        }}
      >
        Send reply
      </button>
    </div>
  );
}
