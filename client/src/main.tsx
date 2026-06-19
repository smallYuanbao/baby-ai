/**
 * @file main.tsx
 * @description Application entry point for the baby-ai client.
 *
 * This file bootstraps the React application by:
 * 1. Creating a React root on the DOM element with id "root".
 * 2. Rendering the top-level <App /> component wrapped in React.StrictMode,
 *    which activates additional development-time checks (e.g., double-invoking
 *    render functions, detecting side-effects in deprecated lifecycle methods).
 * 3. Importing the global Less stylesheet to ensure base styles, resets, and
 *    CSS custom properties are available across the entire component tree.
 *
 * It is intentionally minimal — all routing, state management, and feature
 * composition is delegated to the <App /> component and its children.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.less';

// Mount the React application into the DOM.
// The non-null assertion (!) is safe here because index.html is guaranteed to
// contain a <div id="root"></div> — if it is missing, this is a hard failure
// that should be caught immediately during development.
ReactDOM.createRoot(document.getElementById('root')!).render(
  // React.StrictMode enables additional runtime checks in development builds
  // only. It does not affect production behaviour.
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
