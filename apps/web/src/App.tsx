import { AppShell } from './layout/AppShell';
import { useApiSync } from './data/useApiSync';

export function App() {
  // hydrates from the API when VITE_API_URL is set; no-op otherwise (local store)
  useApiSync();
  return <AppShell />;
}
