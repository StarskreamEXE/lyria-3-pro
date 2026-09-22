import { TopBar } from './components/TopBar';
import { CenterPanel } from './components/CenterPanel';
import { BottomBar } from './components/BottomBar';

export default function App() {
  return (
    <div className="h-screen w-full flex flex-col bg-lyria-bg text-lyria-text-main overflow-hidden select-none">
      <TopBar />
      <div className="flex-1 flex min-h-0 relative">
        <CenterPanel />
      </div>
      <BottomBar />
    </div>
  );
}
