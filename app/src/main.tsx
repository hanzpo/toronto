import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

// No StrictMode: its double-mount would create two renderers.
createRoot(document.getElementById('root')!).render(<App />);
