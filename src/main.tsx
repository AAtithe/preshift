import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics, type BeforeSendEvent } from '@vercel/analytics/react';
import { App } from './ui/App';
import './styles.css';

/** Page views count screens, not clients: the address goes with only the screen it names, never a site, week, hash or token. */
const screenOnly = (event: BeforeSendEvent): BeforeSendEvent => {
  const url = new URL(event.url);
  const view = url.searchParams.get('view');
  return { ...event, url: `${url.origin}${url.pathname}${view ? `?view=${encodeURIComponent(view)}` : ''}` };
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Analytics beforeSend={screenOnly} />
  </StrictMode>,
);
