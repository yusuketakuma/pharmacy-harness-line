import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import { initLiff, PHARMACY_LIFF_BUILD_MARKER } from './lib/liff-auth.js';
import { renderStartupError } from './lib/startup-error.js';
import './index.css';

(async () => {
  const root = document.getElementById('root')!;
  root.dataset.pharmacyLiffBuild = PHARMACY_LIFF_BUILD_MARKER;
  try {
    if (!await initLiff()) {
      root.textContent = 'LINEログインへ移動しています…';
      return;
    }
    createRoot(root).render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>,
    );
  } catch (err) {
    renderStartupError(root, err);
  }
})();
