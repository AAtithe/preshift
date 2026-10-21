import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './staff.css';
import { StaffApp } from './StaffApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StaffApp />
  </StrictMode>,
);
