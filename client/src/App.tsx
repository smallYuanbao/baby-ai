/**
 * @file App.tsx
 * @description Root application component for the Baby AI client.
 *
 * This file serves as the top-level entry point for the React application UI.
 * It wraps the entire app in the AuthProvider and conditionally renders either
 * the AuthPage (login/register) or the main app shell with three feature tabs
 * (Chat, Growth, Play).
 *
 * Key design decisions:
 * - Auth state is lifted into AuthProvider so all child components have access.
 * - Session is restored from the HttpOnly refresh cookie on mount — a brief
 *   loading spinner is shown while this happens.
 * - All tab panels remain mounted at all times (hidden/shown via CSS) rather
 *   than being conditionally rendered, preserving in-progress state.
 */

import { useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AuthPage } from './components/auth/AuthPage';
import { AppShell, type TabId } from './components/layout/AppShell';
import { ChatContainer } from './components/chat/ChatContainer';
import { GrowthContainer } from './components/growth/GrowthContainer';
import { PlayContainer } from './components/play/PlayContainer';
import styles from './App.module.less';

/**
 * Inner app — rendered only when the auth state is resolved.
 * Shows the AuthPage for unauthenticated users or the main app shell.
 */
function AppContent() {
  const { isAuthenticated, isLoading } = useAuth();

  // While checking for an existing session, show a centered spinner
  // so the user doesn't see a flash of the login page.
  if (isLoading) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <p>加载中...</p>
      </div>
    );
  }

  // Not logged in — show the auth page (login / register).
  if (!isAuthenticated) {
    return <AuthPage />;
  }

  // Logged in — show the main app.
  return <MainApp />;
}

/**
 * Main application shell with three feature tabs.
 * Only rendered when the user is authenticated.
 */
function MainApp() {
  const [activeTab, setActiveTab] = useState<TabId>('chat');

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      <div className={activeTab === 'chat' ? styles.tabPanel : styles.hidden}>
        <ChatContainer />
      </div>
      <div className={activeTab === 'growth' ? styles.tabPanel : styles.hidden}>
        <GrowthContainer />
      </div>
      <div className={activeTab === 'play' ? styles.tabPanel : styles.hidden}>
        <PlayContainer />
      </div>
    </AppShell>
  );
}

/**
 * Root component — wraps the entire application in the auth provider.
 */
function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
