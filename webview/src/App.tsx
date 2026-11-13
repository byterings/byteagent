import { useEffect } from 'react';
import { Icon, Logo, Spinner } from './icons';
import { useStore } from './store';
import { ChatView } from './views/ChatView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';

export function App() {
  const { state, dispatch } = useStore();
  const { app, view, toasts } = state;

  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[0];
    if (!oldest) return;
    const timer = window.setTimeout(() => dispatch({ type: 'dismissToast', id: oldest.id }), 6000);
    return () => window.clearTimeout(timer);
  }, [toasts, dispatch]);

  let body;
  if (!app.ready) {
    body = (
      <div className="center">
        <Logo />
        <Spinner />
      </div>
    );
  } else if (app.profiles.length === 0 || view === 'settings') {
    body = <SettingsView />;
  } else if (view === 'history') {
    body = <HistoryView />;
  } else {
    body = <ChatView />;
  }

  return (
    <div className="app">
      {body}
      {toasts.length > 0 && (
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast--${toast.level}`}>
              <Icon name={toast.level === 'error' ? 'error' : toast.level === 'warn' ? 'warning' : 'info'} />
              <span>{toast.message}</span>
              <button className="btn btn--ghost btn--icon" onClick={() => dispatch({ type: 'dismissToast', id: toast.id })} aria-label="Dismiss">
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
