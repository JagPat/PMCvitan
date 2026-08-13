import { useStore } from '@/store/store';
import { ApproveModal } from '@/screens/modals/ApproveModal';
import { ChangeModal } from '@/screens/modals/ChangeModal';
import { WithdrawModal } from '@/screens/modals/WithdrawModal';
import { QrModal } from '@/screens/modals/QrModal';

export function ModalHost() {
  const type = useStore((s) => s.modal.type);
  if (type === 'approve') return <ApproveModal />;
  if (type === 'change') return <ChangeModal />;
  if (type === 'withdraw') return <WithdrawModal />;
  if (type === 'qr') return <QrModal />;
  return null;
}
