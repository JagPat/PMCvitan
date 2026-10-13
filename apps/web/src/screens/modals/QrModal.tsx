import { Modal, Button } from '@/components';
import { useStore } from '@/store/store';
import { qrModalLabels as L } from '@vitan/shared';

const finderMask =
  'radial-gradient(circle at 18px 18px,transparent 12px,#000 0),radial-gradient(circle at calc(100% - 18px) 18px,transparent 12px,#000 0),radial-gradient(circle at 18px calc(100% - 18px),transparent 12px,#000 0),linear-gradient(#000,#000)';

/** Worker self-check-in QR modal. "Simulate a scan" increments the crew. */
export function QrModal() {
  const closeModal = useStore((s) => s.closeModal);
  const scanWorker = useStore((s) => s.scanWorker);
  const lang = useStore((s) => s.lang);

  return (
    <Modal onClose={closeModal} labelledBy="qr-title">
      <div style={{ padding: '26px 24px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.18em', color: 'var(--amber-text)' }}>
          {L.eyebrow[lang]}
        </div>
        <div id="qr-title" style={{ fontSize: 19, fontWeight: 700, marginTop: 8 }}>
          {L.title[lang]}
        </div>
        <div
          style={{
            width: 172,
            height: 172,
            margin: '18px auto 6px',
            background: '#fff',
            border: '1px solid var(--hairline)',
            borderRadius: 14,
            padding: 16,
            position: 'relative',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              background: 'conic-gradient(#23211C 0 25%,#fff 0 50%,#23211C 0 75%,#fff 0)',
              backgroundSize: '14px 14px',
              borderRadius: 4,
              WebkitMask: finderMask,
              WebkitMaskComposite: 'source-over',
              mask: finderMask,
              maskComposite: 'add',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%,-50%)',
              width: 34,
              height: 34,
              background: 'var(--accent)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            V
          </div>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--faint)' }}>
          {L.site[lang]}: AMBLI · {L.validToday[lang]}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.5 }}>
          {L.explain[lang]}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" style={{ flex: 1 }} onClick={closeModal}>
            {L.done[lang]}
          </Button>
          <Button variant="ink" style={{ flex: 1.3 }} onClick={scanWorker}>
            {L.simulate[lang]}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
