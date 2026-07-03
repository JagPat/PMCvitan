import { useStore } from '@/store/store';
import { ROLE_LABEL, ROLE_SUBTITLE } from '@/lib/screens';
import type { Role } from '@vitan/shared';

const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor'];

/**
 * Persona switcher — the session/identity control. Until auth (Phase 7) this
 * simulates "signed in as", swapping the permission-filtered navigation and data
 * scope for each role.
 */
export function RolePicker({ compact = false }: { compact?: boolean }) {
  const role = useStore((s) => s.role);
  const setRole = useStore((s) => s.setRole);

  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8.5,
          letterSpacing: '.22em',
          color: 'rgba(237,231,218,.4)',
          marginBottom: 9,
        }}
      >
        VIEWING AS
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {ROLES.map((r) => {
          const active = role === r;
          return (
            <button
              key={r}
              onClick={() => setRole(r)}
              style={{
                padding: '9px 4px',
                borderRadius: 8,
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                fontSize: 11.5,
                cursor: 'pointer',
                border: `1px solid ${active ? '#B4462E' : 'rgba(237,231,218,.16)'}`,
                background: active ? '#B4462E' : 'transparent',
                color: active ? '#fff' : 'rgba(237,231,218,.7)',
              }}
            >
              {ROLE_LABEL[r]}
            </button>
          );
        })}
      </div>
      {!compact && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(237,231,218,.55)', marginTop: 8 }}>
          {ROLE_SUBTITLE[role]}
        </div>
      )}
    </div>
  );
}
