import { useStore } from '@/store/store';
import { DashboardScreen } from '@/screens/DashboardScreen';
import { ScheduleScreen } from '@/screens/ScheduleScreen';
import { DecisionLogScreen } from '@/screens/DecisionLogScreen';
import { InspectionReviewScreen } from '@/screens/InspectionReviewScreen';
import { ClientDecisionsScreen } from '@/screens/ClientDecisionsScreen';
import { ClientHealthScreen } from '@/screens/ClientHealthScreen';
import { DailyLogScreen } from '@/screens/DailyLogScreen';
import { EngineerChecklistScreen } from '@/screens/EngineerChecklistScreen';
import { DrawingsScreen } from '@/screens/DrawingsScreen';
import { TeamScreen } from '@/screens/TeamScreen';
import { PortfolioScreen } from '@/screens/PortfolioScreen';
import { TeamAccessScreen } from '@/screens/TeamAccessScreen';

export function ScreenView() {
  const screen = useStore((s) => s.screen);
  switch (screen) {
    case 'dashboard':
      return <DashboardScreen />;
    case 'site-schedule':
      return <ScheduleScreen />;
    case 'decision-log':
      return <DecisionLogScreen />;
    case 'inspect-review':
      return <InspectionReviewScreen />;
    case 'client-decisions':
      return <ClientDecisionsScreen />;
    case 'client-health':
      return <ClientHealthScreen />;
    case 'daily-log':
      return <DailyLogScreen />;
    case 'engineer-check':
      return <EngineerChecklistScreen />;
    case 'drawings':
      return <DrawingsScreen />;
    case 'team':
      return <TeamScreen />;
    case 'portfolio':
      return <PortfolioScreen />;
    case 'team-access':
      return <TeamAccessScreen />;
    default:
      return null;
  }
}
