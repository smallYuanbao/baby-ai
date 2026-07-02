/**
 * Header — App shell top bar.
 *
 * Renders the global site header with the app logo, title, and the current
 * user's info + logout button when authenticated.
 *
 * Layout role: sits at the top of the main app layout, above the sidebar /
 * content area. Uses `flex-shrink: 0` so it never collapses when the
 * viewport is short.
 */

import { useAuth } from '../../contexts/AuthContext';
import styles from './Header.module.less';

/**
 * App header — branding bar with user menu.
 *
 * When the user is authenticated, displays their nickname (or email fallback)
 * and a logout button in the top-right corner.
 */
export function Header() {
  const { user, logout } = useAuth();

  return (
    <header className={styles.header}>
      <div className={styles.container}>
        {/* AI teddy-bear mascot — inline SVG to avoid an extra network round-trip */}
        <div className={styles.avatar}>
          <svg viewBox="0 0 100 100" className={styles.avatarSvg}>
            {/* Head — large circle at the bottom */}
            <circle cx="50" cy="55" r="28" fill="#fff7ed" />
            {/* Left ear */}
            <circle cx="28" cy="32" r="12" fill="#fff7ed" />
            {/* Right ear */}
            <circle cx="72" cy="32" r="12" fill="#fff7ed" />
            {/* Left ear inner */}
            <circle cx="28" cy="32" r="6" fill="#fdba74" />
            {/* Right ear inner */}
            <circle cx="72" cy="32" r="6" fill="#fdba74" />
            {/* Left eye */}
            <circle cx="40" cy="52" r="4" fill="#1a1a2e" />
            {/* Right eye */}
            <circle cx="60" cy="52" r="4" fill="#1a1a2e" />
            {/* Nose */}
            <ellipse cx="50" cy="62" rx="5" ry="3.5" fill="#f97316" />
            {/* Mouth — quadratic bezier smile */}
            <path d="M40 70 Q50 78 60 70" stroke="#f97316" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </svg>
        </div>
        <div className={styles.brand}>
          <h1 className={styles.title}>育儿AI助手</h1>
          <p className={styles.subtitle}>用科学知识陪伴宝宝成长 🧸</p>
        </div>

        {/* User section — right-aligned */}
        {user && (
          <div className={styles.userSection}>
            <span className={styles.userName}>
              {user.nickname || user.email}
            </span>
            <button className={styles.logoutBtn} onClick={logout} title="退出登录">
              退出
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
