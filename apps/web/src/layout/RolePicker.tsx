import { useStore } from '@/store/store';
import { selectRoles } from '@/store/selectors';
import { ROLE_LABEL, ROLE_SUBTITLE } from '@/lib/screens';

/**
 * Persona switcher — the session/identity control. Until auth (Phase 7) this
 * simulates "signed in as", swapping the permission-filtered navigation and data
 * scope for each role.
 */
export function RolePicker({ compact = false }: { compact?: boolean }) {
  const role = useStore((s) => s.role);
  const setRole = useStore((s) => s.setRole);
  // B2 — the personas on offer follow the shell's rollout (a reserved role is not offered)
  const roles = useStore(selectRoles);

  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8.5,
          letterSpacing: '.22em',
          color: 'rgba(237,231,218,.62)',
          marginBottom: 9,
        }}
      >
        VIEWING AS
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {roles.map((r) => {
          const active = role === r;
          return (
            <button
              key={r}
              onClick={() => setRole(r)}
              style={{
                minHeight: 44,
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
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(237,231,218,.62)', marginTop: 8 }}>
          {ROLE_SUBTITLE[role]}
        </div>
      )}
    </div>
  );
}
