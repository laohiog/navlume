import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { FirstRunApp } from './FirstRunSetup.js';
import './styles/main.css';

// Hashes belong to application routing; skipping content must preserve the page.
document.querySelector<HTMLAnchorElement>('.skip-link')?.addEventListener('click', (event) => {
  const main = document.getElementById('main-content');
  if (!main) return;
  event.preventDefault();
  main.focus();
  main.scrollIntoView({ block: 'start' });
});

const container = document.getElementById('root');

if (container === null) {
  throw new Error('Root container #root was not found.');
}

createRoot(container).render(
  <StrictMode>
    <FirstRunApp />
  </StrictMode>,
);
