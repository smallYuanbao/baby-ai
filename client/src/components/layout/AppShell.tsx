import type { ReactNode } from 'react';
import { Header } from './Header';
import { TabBar } from './TabBar';
import styles from './AppShell.module.less';

/**
 * Identifies one of the three top-level navigation tabs in the app.
 * - `chat`   — AI conversation screen
 * - `growth` — child development tracking / milestones
 * - `play`   — interactive activities and games
 */
type TabId = 'chat' | 'growth' | 'play';

/**
 * Props accepted by the {@link AppShell} root layout component.
 */
interface AppShellProps {
  /** The active page content rendered into the shell's main area. */
  children: ReactNode;
  /** Which bottom-tab is currently selected. */
  activeTab: TabId;
  /** Called when the user taps a different bottom-tab. */
  onTabChange: (tab: TabId) => void;
}

export type { TabId };

/**
 * Root application shell providing the persistent app chrome: a fixed top
 * header, a scrollable main content area, and a bottom tab bar for primary
 * navigation.
 *
 * State responsibility:
 * - This component is a pure layout — it does **not** own `activeTab`. The
 *   parent (typically a router or page-level controller) owns and drives the
 *   active-tab state via the `activeTab` / `onTabChange` props.
 *
 * Accessibility:
 * - The `<main>` landmark wraps dynamic child content so screen-reader users
 *   can skip to the primary page content.
 */
export function AppShell({ children, activeTab, onTabChange }: AppShellProps) {
  return (
    <div className={styles.wrapper}>
      {/* Fixed top bar — app logo / user avatar */}
      <Header />
      {/* Scrollable content area; children are swapped by the parent
          based on the currently active tab. */}
      <main className={styles.main}>
        {children}
      </main>
      {/* Bottom tab bar for primary navigation between Chat, Growth, Play */}
      <TabBar activeTab={activeTab} onTabChange={onTabChange} />
    </div>
  );
}
