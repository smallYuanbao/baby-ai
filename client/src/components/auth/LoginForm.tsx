/**
 * Login form component.
 *
 * Renders an email + password form with client-side validation.
 * On submit, delegates to the auth context's `login()` method.
 * Displays server-side error messages inline.
 */

import { useState, type FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import styles from './Auth.module.less';

export function LoginForm() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError('请填写邮箱和密码');
      return;
    }

    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err: any) {
      setError(err.message || '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      {error && <div className={styles.error}>{error}</div>}

      <label className={styles.label}>
        邮箱
        <input
          className={styles.input}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          autoComplete="email"
          disabled={submitting}
        />
      </label>

      <label className={styles.label}>
        密码
        <input
          className={styles.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入密码"
          autoComplete="current-password"
          disabled={submitting}
        />
      </label>

      <button className={styles.submitBtn} type="submit" disabled={submitting}>
        {submitting ? '登录中...' : '登录'}
      </button>
    </form>
  );
}
