import { useMemo } from 'react';
import { useStore } from '@/store/store';
import { can, type Decision } from '@vitan/shared';

/**
 * Who may withdraw a decision's open change request — the rule the SERVICE enforces, mirrored so the button only
 * appears where the server would accept the call: the requester or the PMC. Phase 6 task 4d-ii-b / B4 (P33's web
 * arm): a request the ARCHITECT opened by rejecting a countersign (`origin: 'countersign_rejection'`) cannot be
 * withdrawn by anyone — withdrawing it would complete an approval the architect refused — and the service 409s the
 * call (4d-ii-a / A7b), so the affordance is not offered. Only that origin is named: a request with no origin is a
 * standard one from any server, before or after 4d.
 *
 * Shared by the register and the client's waiting card (#482), so the two never disagree.
 */
export function useMayWithdrawChange(): (d: Decision) => boolean {
  const role = useStore((s) => s.role);
  const sessionToken = useStore((s) => s.sessionToken);
  // who am I? — the JWT sub, for the requester-may-withdraw rule (null in demo mode)
  const mySub = useMemo(() => {
    if (!sessionToken) return null;
    try {
      return (JSON.parse(atob(sessionToken.split('.')[1])) as { sub?: string }).sub ?? null;
    } catch {
      return null;
    }
  }, [sessionToken]);
  return useMemo(
    () => (d: Decision): boolean =>
      can('decision.withdrawChange', role)
      && d.changeRequest?.origin !== 'countersign_rejection'
      && (role === 'pmc' || (!!mySub && d.changeRequest?.requestedById === mySub)),
    [role, mySub],
  );
}
