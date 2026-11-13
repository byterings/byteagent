import { Logo } from '../icons';
import { useStore } from '../store';

export function ChatView() {
  const { state } = useStore();
  const active = state.app.profiles.find((p) => p.id === state.app.activeProfileId);
  return (
    <div className="center">
      <Logo />
      <h2>ByteAgent</h2>
      <p className="hint">Connected to {active?.name ?? 'a provider'}.</p>
    </div>
  );
}
