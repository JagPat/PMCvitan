import { useStore } from '@/store/store';
import { InboxScreen } from '@/screens/InboxScreen';
import { DraftsScreen } from '@/screens/DraftsScreen';
import { DashboardScreen } from '@/screens/DashboardScreen';
import { ScheduleScreen } from '@/screens/ScheduleScreen';
import { DecisionLogScreen } from '@/screens/DecisionLogScreen';
import { InspectionReviewScreen } from '@/screens/InspectionReviewScreen';
import { ClientDecisionsScreen } from '@/screens/ClientDecisionsScreen';
import { ClientHealthScreen } from '@/screens/ClientHealthScreen';
import { DailyLogScreen } from '@/screens/DailyLogScreen';
import { EngineerChecklistScreen } from '@/screens/EngineerChecklistScreen';
import { DrawingsScreen } from '@/screens/DrawingsScreen';
import { PlacesScreen } from '@/screens/PlacesScreen';
import { TeamScreen } from '@/screens/TeamScreen';
import { PortfolioScreen } from '@/screens/PortfolioScreen';
import { TeamAccessScreen } from '@/screens/TeamAccessScreen';
import { MaterialsScreen } from '@/screens/MaterialsScreen';

export function ScreenView() {
  const screen = useStore((s) => s.screen);
  switch (screen) {
    case 'inbox':
      return <InboxScreen />;
    case 'drafts':
      return <DraftsScreen />;
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
    case 'places':
      return <PlacesScreen />;
    case 'team':
      return <TeamScreen />;
    case 'portfolio':
      return <PortfolioScreen />;
    case 'team-access':
      return <TeamAccessScreen />;
    case 'materials':
      return <MaterialsScreen />;
    default:
      return null;
  }
}
