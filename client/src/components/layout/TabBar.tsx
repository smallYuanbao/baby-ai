/**
 * TabBar — Bottom tab navigation bar for the baby-ai mobile app.
 *
 * Renders a horizontal row of tab buttons (Chat / Growth / Play) anchored at
 * the bottom of the viewport. Each tab button displays an emoji icon and a
 * Chinese label. The component is stateless on its own — the currently active
 * tab and the change handler are lifted to the parent.
 *
 * @file   Bottom navigation tabs for the main app shell.
 * @role   Primary navigation between the three core sections of the app.
 * @state  None — fully controlled via `activeTab` prop.
 */

import styles from './TabBar.module.less';

/** Union of valid tab identifiers used across the app. */
type TabId = 'chat' | 'growth' | 'play';

/** Descriptor for a single tab button in the bar. */
interface Tab {
  /** Unique key used for routing / tracking the active tab. */
  id: TabId;
  /** Human-readable label shown below the icon. */
  label: string;
  /** Emoji character rendered as the tab's icon. */
  icon: string;
}

/** Static tab definitions — shared across all instances. */
const TABS: Tab[] = [
  { id: 'chat', label: '聊天', icon: '💬' },
  { id: 'growth', label: '成长', icon: '📈' },
  { id: 'play', label: '玩乐', icon: '🎮' },
];

/** Props for the {@link TabBar} component. */
interface TabBarProps {
  /** The currently selected tab id. */
  activeTab: TabId;
  /** Called with the new tab id when the user taps a tab. */
  onTabChange: (tab: TabId) => void;
}

/**
 * Bottom tab bar for switching between the app's main sections.
 *
 * Each tab is rendered as a `<button>` so it is natively focusable and
 * keyboard-accessible. The active tab receives a distinct visual treatment
 * (color, background tint, scale-up animation on the icon, and a small
 * indicator bar).
 */
export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    // The `safe-area-bottom` utility class ensures the bar clears the iOS
    // home indicator and other device-specific bottom safe areas.
    <nav className={`${styles.nav} safe-area-bottom`}>
      {TABS.map((tab) => {
        // Determine whether this tab is the currently active one.
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            // Notify the parent of the tab switch on tap / click.
            onClick={() => onTabChange(tab.id)}
            // Swap between active and inactive style classes for
            // color, background, and hover treatment.
            className={`${styles.tab} ${isActive ? styles.tabActive : styles.tabInactive}`}
          >
            {/* Icon — scales up slightly when active */}
            <span className={`${styles.icon} ${isActive ? styles.iconActive : ''}`}>
              {tab.icon}
            </span>
            {/* Label — bolder when active */}
            <span className={`${styles.label} ${isActive ? styles.labelActive : ''}`}>
              {tab.label}
            </span>
            {/* Small colored indicator bar rendered only for the active tab */}
            {isActive && <span className={styles.indicator} />}
          </button>
        );
      })}
    </nav>
  );
}
