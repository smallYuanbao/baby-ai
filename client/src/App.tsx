/**
 * @file App.tsx
 * @description Root application component for the Baby AI client.
 *
 * This file serves as the top-level entry point for the React application UI.
 * It composes the overall page layout (AppShell) with three primary feature
 * tabs — Chat, Growth, and Play — and manages which tab is currently active.
 *
 * Key design decisions:
 * - All tab panels remain mounted at all times (hidden/shown via CSS) rather
 *   than being conditionally rendered. This preserves in-progress state (e.g.,
 *   chat messages, scroll position, form inputs) when the user switches tabs.
 * - Active-tab state is lifted here so that both the shell (navigation) and
 *   the panel visibility share a single source of truth.
 */

import { useState } from 'react';
import { AppShell, type TabId } from './components/layout/AppShell';
import { ChatContainer } from './components/chat/ChatContainer';
import { GrowthContainer } from './components/growth/GrowthContainer';
import { PlayContainer } from './components/play/PlayContainer';
import styles from './App.module.less';

/**
 * Root application component.
 *
 * Renders the AppShell layout with three child tab panels (Chat, Growth, Play).
 * Uses CSS visibility toggling instead of conditional rendering so that each
 * container's internal state survives tab switches.
 *
 * @returns {JSX.Element} The full application shell with tab-aware content panels.
 */
function App() {
  // Track the currently selected tab; defaults to the chat view.
  const [activeTab, setActiveTab] = useState<TabId>('chat');

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      {/*
       * Tab panels use CSS `display: none` (via styles.hidden) rather than
       * conditional rendering. This keeps each container mounted in the React
       * tree so that internal state — chat history, growth data, game progress,
       * scroll offsets — is preserved when the user navigates between tabs.
       */}
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

export default App;
