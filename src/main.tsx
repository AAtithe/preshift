import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './ui/App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
