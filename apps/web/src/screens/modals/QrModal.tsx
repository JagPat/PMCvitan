import { Modal, Button } from '@/components';
import { useStore } from '@/store/store';

const finderMask =
  'radial-gradient(circle at 18px 18px,transparent 12px,#000 0),radial-gradient(circle at calc(100% - 18px) 18px,transparent 12px,#000 0),radial-gradient(circle at 18px calc(100% - 18px),transparent 12px,#000 0),linear-gradient(#000,#000)';

/** Worker self-check-in QR modal. "Simulate a scan" increments the crew. */
export function QrModal() {
  const closeModal = useStore((s) => s.closeModal);
  const scanWorker = useStore((s) => s.scanWorker);

  return (
    <Modal onClose={closeModal} labelledBy="qr-title">
      <div style={{ padding: '26px 24px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.18em', color: 'var(--amber-text)' }}>
          WORKER SELF CHECK-IN
        </div>
        <div id="qr-title" style={{ fontSize: 19, fontWeight: 700, marginTop: 8 }}>
          Ask the worker to scan this
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
          SITE: AMBLI · VALID FOR TODAY ONLY
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.5 }}>
          Each worker scans once at the gate. Their trade, time and a face photo are stamped — no paper muster, no proxy attendance.
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" style={{ flex: 1 }} onClick={closeModal}>
            Done
          </Button>
          <Button variant="ink" style={{ flex: 1.3 }} onClick={scanWorker}>
            Simulate a scan
          </Button>
        </div>
      </div>
    </Modal>
  );
}
