import { useStore } from '@/store/store';
import { Eyebrow, ResultChip, Button } from '@/components';
import { X } from '@/lib/icons';
import { swatch as swatchGradient } from '@vitan/shared';
import styles from './responsive.module.css';

export function InspectionReviewScreen() {
  const review = useStore((s) => s.review);
  const toggleReject = useStore((s) => s.toggleReject);
  const approveInspection = useStore((s) => s.approveInspection);
  const sendReinspection = useStore((s) => s.sendReinspection);

  const rejectedCount = review.items.filter((it) => it.rejected).length;
  const summary = review.decided ? 'Decision recorded ✓' : `${rejectedCount} item(s) marked for rejection`;

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <Eyebrow>INSPECTION REVIEW</Eyebrow>
      <div className={styles.headRule} style={{ margin: '6px 0 22px' }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>{review.title}</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 7, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>{review.zone}</span>
            <span>·</span>
            <span>Submitted by {review.by}</span>
            <span>·</span>
            <span>{review.date}</span>
          </div>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '5px 11px', border: '1px solid var(--amber-border)', background: 'var(--amber-chip)', color: 'var(--amber-text)', borderRadius: 20 }}>
          {review.decided ? 'REVIEWED' : 'AWAITING REVIEW'}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {review.items.map((it, i) => {
          const border = it.rejected ? '#D9B4B0' : it.result === 'FAIL' ? '#E7CBC7' : 'var(--hairline)';
          return (
            <div key={it.name} className={styles.reviewRow} style={{ background: 'var(--panel)', border: `1px solid ${border}`, borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ width: 130, height: 100, flex: 'none', borderRadius: 8, background: swatchGradient(it.swatch), position: 'relative', overflow: 'hidden' }}>
                <span style={{ position: 'absolute', left: 6, bottom: 6, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,.9)', background: 'rgba(0,0,0,.4)', padding: '1px 5px', borderRadius: 3 }}>PHOTO</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{it.name}</span>
                  <ResultChip result={it.result} />
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>{it.note}</div>
                {it.rejected && (
                  <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--red-solid)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <X size={12} /> Rejected — re-inspection task created
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center' }}>
                <Button
                  variant={it.rejected ? 'danger' : 'dangerOutline'}
                  onClick={() => toggleReject(i)}
                  style={{ padding: '9px 14px', fontSize: 12, whiteSpace: 'nowrap' }}
                >
                  {it.rejected ? 'Rejected ✕' : 'Reject item'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.stickyFoot} style={{ marginTop: 26 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="success" onClick={approveInspection} style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>Approve Inspection</Button>
          <Button variant="dangerOutline" onClick={sendReinspection} data-testid="send-reinspection" style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>Send Rejections &amp; Create Re-inspection</Button>
        </div>
        <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--faint)', marginTop: 9 }}>{summary}</div>
      </div>
    </div>
  );
}
