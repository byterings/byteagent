import { Icon } from '../icons';
import { useStore } from '../store';

export function HistoryView() {
  const { dispatch } = useStore();
  return (
    <div className="page">
      <header className="page__header">
        <button className="btn btn--ghost btn--icon" onClick={() => dispatch({ type: 'setView', view: 'chat' })} title="Back to chat" aria-label="Back to chat">
          <Icon name="arrowLeft" />
        </button>
        <h2>History</h2>
      </header>
      <p className="hint">No conversations yet.</p>
    </div>
  );
}
