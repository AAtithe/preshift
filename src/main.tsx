import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AcceptInvite } from './ui/access/AcceptInvite';
import { App } from './ui/App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname === '/accept-invite' ? <AcceptInvite /> : <App />}
  </StrictMode>,
);
