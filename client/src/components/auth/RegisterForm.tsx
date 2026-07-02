/**
 * Register form component.
 *
 * Renders an email + password + optional nickname form with client-side
 * validation. On submit, delegates to the auth context's `register()` method.
 */

import { useState, type FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import styles from './Auth.module.less';

export function RegisterForm() {
  const { register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('请填写邮箱');
      return;
    }
    if (password.length < 6) {
      setError('密码至少需要 6 个字符');
      return;
    }

    setSubmitting(true);
    try {
      await register(email.trim(), password, nickname.trim() || undefined);
    } catch (err: any) {
      setError(err.message || '注册失败，请稍后重试');
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
        昵称 <span className={styles.optional}>(选填)</span>
        <input
          className={styles.input}
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="怎么称呼你？"
          maxLength={32}
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
          placeholder="至少 6 个字符"
          autoComplete="new-password"
          disabled={submitting}
        />
      </label>

      <button className={styles.submitBtn} type="submit" disabled={submitting}>
        {submitting ? '注册中...' : '注册'}
      </button>
    </form>
  );
}
