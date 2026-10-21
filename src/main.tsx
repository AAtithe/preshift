import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { LiveApp } from './ui/LiveApp';
import { loadDemoState, saveDemoState } from './ui/store';
import './styles.css';

// One build serves both: /demo/ is the open demo on sample data held in the browser,
// /app/ is the signed-in product backed by Neon.
const isDemo = window.location.pathname.startsWith('/demo');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDemo ? <App mode="demo" initial={loadDemoState()} persist={saveDemoState} /> : <LiveApp />}
  </StrictMode>,
);
