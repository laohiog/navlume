import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { FirstRunApp } from './FirstRunSetup.js';
import './styles/main.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('Root container #root was not found.');
}

createRoot(container).render(
  <StrictMode>
    <FirstRunApp />
  </StrictMode>,
);
