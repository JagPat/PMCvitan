import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Button } from '@/components';
import { can, viewerIsConsultee, type Decision } from '@vitan/shared';

/**
 * Phase 6 unit 4c-ii (§A) — the consultation thread under a decision.
 *
 * Consultation INFORMS; it never gates. Nothing here moves a status or changes a gate verdict:
 * the PMC asks a named member a question, that member answers once, and both facts are permanent.
 *
 * **The capability is read HERE, exactly as the server reads it** (review round 26). Gating only
 * the commands and the emitter would leave the upgraded bundle rendering request/respond controls
 * during the whole window in which every project is still gate-off — between 4c-ii and 4c-iii,
 * and for as long as the drain directive is outstanding. Controls whose every request returns a
 * deterministic 404 are not a byte-identical gate-off state; they are a visibly broken one. So
 * this component renders NOTHING off-pilot, and this client read retires in 4c-iv together with
 * the server-side ones — the gate goes in one place, not two.
 */
export function ConsultationThread({ decision }: { decision: Decision }) {
  const role = useStore((s) => s.role);
  const sessionUserId = useStore((s) => s.sessionUserId);
  const capabilities = useStore(useShallow((s) => s.capabilities));
  const members = useStore(useShallow((s) => s.members));
  const requestConsultation = useStore((s) => s.requestConsultation);
  const respondToConsultation = useStore((s) => s.respondToConsultation);

  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [consultee, setConsultee] = useState('');
  const [advice, setAdvice] = useState('');
  const [recommend, setRecommend] = useState<number | ''>('');

  if (!capabilities.includes('consultation')) return null;

  const thread = decision.consultations ?? [];
  // Asking is only meaningful while the question is open — the same eligibility the server
  // enforces, mirrored so no affordance offers an action the server answers with a 409.
  const open = !decision.draft && (decision.status === 'pending' || decision.status === 'change');
  const mayAsk = open && can('consultation.request', role);
  // The viewer's OWN unanswered consultation, in the CURRENT cycle. A consultation from a closed
  // cycle is not answerable — the approval that ended that cycle closed it — so no compose box
  // appears for one, which is the same answer the respond command gives.
  const mine =
    open && viewerIsConsultee(thread, decision.approvalCycle, sessionUserId)
      ? thread.find((c) => c.consulteeUserId === sessionUserId && c.openCycle === decision.approvalCycle && !c.response)
      : undefined;

  const nameOf = (userId: string): string => members.find((m) => m.userId === userId)?.name ?? 'a team member';
  // only ACTIVE members can be asked, and asking yourself records nothing
  const askable = members.filter((m) => m.status === 'active' && m.membershipId && m.userId !== sessionUserId);

  if (thread.length === 0 && !mayAsk && !mine) return null;

  return (
    <div
      data-testid={`consultation-thread-${decision.id}`}
      style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(35,33,28,.035)', border: '1px solid rgba(35,33,28,.12)' }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)' }}>Advice</div>

      {thread.map((c) => (
        <div key={c.id} data-testid={`consultation-${c.id}`} style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12.5 }}>
            <strong>{nameOf(c.requestedById)}</strong> asked <strong>{nameOf(c.consulteeUserId)}</strong>: {c.question}
          </div>
          {c.response ? (
            <div style={{ fontSize: 12.5, marginTop: 4, paddingLeft: 10, borderLeft: '2px solid rgba(35,33,28,.18)' }} data-testid={`consultation-answer-${c.id}`}>
              <strong>{nameOf(c.response.respondedById)}</strong>: {c.response.response}
              {c.response.recommendedOptionKey && (
                <span style={{ color: 'var(--muted)' }}> · leans to option {c.response.recommendedOptionKey.toUpperCase()}</span>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 3 }}>Awaiting their advice</div>
          )}
        </div>
      ))}

      {/* the CONSULTEE's own compose box — the affordance the widened audience exists for */}
      {mine && (
        <div style={{ marginTop: 10 }} data-testid={`consultation-respond-${decision.id}`}>
          <textarea
            aria-label="Your advice"
            value={advice}
            onChange={(e) => setAdvice(e.target.value)}
            rows={2}
            style={{ width: '100%', fontSize: 12.5, padding: 8, borderRadius: 8, border: '1px solid var(--hairline)', font: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            {decision.options.length > 0 && (
              <select
                aria-label="Recommend an option"
                value={recommend}
                onChange={(e) => setRecommend(e.target.value === '' ? '' : Number(e.target.value))}
                style={{ fontSize: 12, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--hairline)' }}
              >
                <option value="">No recommendation</option>
                {decision.options.map((o, i) => (
                  <option key={o.key ?? i} value={i}>{o.label}</option>
                ))}
              </select>
            )}
            <Button
              data-testid={`consultation-send-advice-${decision.id}`}
              disabled={!advice.trim()}
              onClick={() => {
                respondToConsultation(decision.id, mine.id, advice, recommend === '' ? undefined : recommend);
                setAdvice('');
                setRecommend('');
              }}
            >
              Send advice
            </Button>
          </div>
        </div>
      )}

      {/* the REQUESTER's affordance */}
      {mayAsk && !asking && (
        <Button data-testid={`consultation-ask-${decision.id}`} onClick={() => setAsking(true)} style={{ marginTop: 10 }}>
          Ask a member
        </Button>
      )}
      {mayAsk && asking && (
        <div style={{ marginTop: 10 }} data-testid={`consultation-ask-form-${decision.id}`}>
          <select
            aria-label="Who to ask"
            value={consultee}
            onChange={(e) => setConsultee(e.target.value)}
            style={{ fontSize: 12, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--hairline)', width: '100%' }}
          >
            <option value="">Choose a member…</option>
            {askable.map((m) => (
              <option key={m.membershipId} value={m.membershipId}>{m.name} · {m.role}</option>
            ))}
          </select>
          <textarea
            aria-label="Your question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            style={{ width: '100%', fontSize: 12.5, padding: 8, borderRadius: 8, border: '1px solid var(--hairline)', marginTop: 6, font: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <Button
              data-testid={`consultation-send-question-${decision.id}`}
              disabled={!consultee || !question.trim()}
              onClick={() => {
                requestConsultation(decision.id, consultee, question);
                setQuestion('');
                setConsultee('');
                setAsking(false);
              }}
            >
              Ask
            </Button>
            <Button onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
