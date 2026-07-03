import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectLogDecisions } from '@/store/selectors';
import { Eyebrow, DecisionChip, Button } from '@/components';
import { Lock } from '@/lib/icons';
import { signed, swatch as swatchGradient, decisionRail } from '@vitan/shared';
import styles from './responsive.module.css';

export function DecisionLogScreen() {
  const rows = useStore(useShallow(selectLogDecisions));
  const openChange = useStore((s) => s.openChange);

  return (
    <div className={`${styles.screen} ${styles.narrow}`}>
      <Eyebrow>CLIENT DECISION LOG</Eyebrow>
      <div className={styles.headRule} style={{ margin: '6px 0 8px' }}>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>Decision Register</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>{rows.length} DECISIONS</div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '10px 0 22px' }}>
        Single source of truth. Once approved, a decision is locked — any change must go through a formal Change Request.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map((d) => {
          const locked = d.status === 'approved';
          const attribution = d.approver
            ? `Approved by ${d.approver} · ${d.date}`
            : `Ageing ${d.ageDays} days · awaiting client`;
          const approvedLine =
            d.status === 'pending' ? `${d.options.length} options presented` : `${d.approvedOption} — ${d.material}`;
          const costStr =
            d.status === 'pending'
              ? 'up to ' + signed(Math.max(...d.options.map((o) => o.delta)))
              : signed(d.cost ?? 0);
          const photoLabel = d.status === 'pending' ? 'OPTIONS' : 'APPROVED';

          return (
            <div
              key={d.id}
              data-testid={`log-row-${d.id}`}
              style={{
                background: 'var(--panel)',
                border: '1px solid var(--hairline)',
                borderLeft: `4px solid ${decisionRail[d.status]}`,
                borderRadius: 12,
                overflow: 'hidden',
                animation: 'vpop .3s',
              }}
            >
              <div className={styles.logRow}>
                <div className={styles.logPhoto} style={{ background: swatchGradient(d.photoSwatch), position: 'relative', flex: 'none' }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: 8,
                      bottom: 8,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 8,
                      color: 'rgba(255,255,255,.9)',
                      background: 'rgba(0,0,0,.4)',
                      padding: '1px 6px',
                      borderRadius: 3,
                    }}
                  >
                    {photoLabel}
                  </span>
                </div>
                <div style={{ flex: 1, padding: '16px 20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{d.id}</span>
                        <span style={{ fontWeight: 600, fontSize: 16 }}>{d.title}</span>
                        {locked && <Lock size={13} data-testid={`lock-${d.id}`} />}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{d.room}</div>
                    </div>
                    <DecisionChip status={d.status} />
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-end',
                      marginTop: 14,
                      paddingTop: 12,
                      borderTop: '1px solid rgba(35,33,28,.1)',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{approvedLine}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 3 }}>{attribution}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 13,
                          fontWeight: 600,
                          color: (d.cost ?? 0) > 0 ? 'var(--ink)' : 'var(--muted)',
                        }}
                      >
                        {costStr}
                      </div>
                      {locked && (
                        <Button
                          variant="outline"
                          onClick={() => openChange(d.id)}
                          style={{ marginTop: 7, padding: '6px 12px', fontSize: 11.5, fontWeight: 500 }}
                        >
                          Request Change
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
