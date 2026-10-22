import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './kiosk.css';
import { KioskApp } from './KioskApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KioskApp />
  </StrictMode>,
);
