import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

// No StrictMode: its double-mount would create two renderers.
createRoot(document.getElementById('root')!).render(<App />);

// Service worker (production only): app shell + schedules for repeat visits
// and offline use; ?sw=0 unregisters it.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const off = new URLSearchParams(location.search).get('sw') === '0';
  addEventListener('load', () => {
    if (off) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    else navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
