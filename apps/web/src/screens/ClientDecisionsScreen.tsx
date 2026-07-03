import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectPending } from '@/store/selectors';
import { Eyebrow, Swatch, Button } from '@/components';
import { Check } from '@/lib/icons';
import { signed, PROJECT } from '@vitan/shared';
import styles from './responsive.module.css';

export function ClientDecisionsScreen() {
  const pending = useStore(useShallow(selectPending));
  const openApprove = useStore((s) => s.openApprove);

  const countLabel = `${pending.length} ${pending.length === 1 ? 'decision waiting' : 'decisions waiting'}`;

  return (
    <div className={styles.clientScreen}>
      <div style={{ padding: '10px 0 16px' }}>
        <Eyebrow size={9}>{PROJECT.short.toUpperCase()}</Eyebrow>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 27, fontWeight: 500, marginTop: 4, lineHeight: 1.15 }}>
          Decisions waiting for you
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>{countLabel} · Please review and approve.</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {pending.map((d) => (
          <div
            key={d.id}
            style={{
              background: '#fff',
              border: '1px solid rgba(35,33,28,.12)',
              borderRadius: 16,
              overflow: 'hidden',
              boxShadow: 'var(--sh-card)',
            }}
          >
            <div style={{ padding: '15px 16px 12px', borderBottom: '1px solid rgba(35,33,28,.08)' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)' }}>
                {d.id} · {d.room}
              </div>
              <div style={{ fontWeight: 700, fontSize: 18, marginTop: 3 }}>{d.title}</div>
            </div>
            <div style={{ padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {d.options.map((o, i) => {
                const isRec = o.recommended;
                return (
                  <div
                    key={o.key}
                    style={{
                      border: `1.5px solid ${isRec ? 'var(--ink)' : 'rgba(35,33,28,.14)'}`,
                      borderRadius: 13,
                      padding: 11,
                      position: 'relative',
                      background: isRec ? '#FBF7F0' : '#fff',
                    }}
                  >
                    {isRec && (
                      <div
                        style={{
                          position: 'absolute',
                          top: -9,
                          left: 12,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 8.5,
                          letterSpacing: '.1em',
                          background: 'var(--ink)',
                          color: 'var(--sidebar-text)',
                          padding: '2px 8px',
                          borderRadius: 10,
                        }}
                      >
                        ★ ARCHITECT'S PICK
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      <Swatch swatch={o.swatch} size={56} radius={10} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14.5 }}>{o.material}</div>
                        <div
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12,
                            color: o.delta === 0 ? 'var(--muted)' : 'var(--amber-text)',
                            marginTop: 2,
                          }}
                        >
                          {o.delta === 0 ? 'Baseline (no extra cost)' : signed(o.delta)}
                        </div>
                      </div>
                    </div>
                    <Button
                      variant={isRec ? 'ink' : 'light'}
                      fullWidth
                      onClick={() => openApprove(d.id, i)}
                      data-testid={`approve-${d.id}-${o.key}`}
                      style={{ marginTop: 11, padding: 12 }}
                    >
                      Approve {o.label}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {pending.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--muted)' }}>
            <div
              style={{
                width: 60,
                height: 60,
                margin: '0 auto',
                borderRadius: '50%',
                background: 'var(--green-chip)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Check size={30} color="var(--green-solid)" strokeWidth={2.5} />
            </div>
            <div style={{ fontWeight: 600, marginTop: 12 }}>All caught up</div>
            <div style={{ fontSize: 12.5, marginTop: 5 }}>No decisions are waiting for your approval right now.</div>
          </div>
        )}
      </div>
    </div>
  );
}
