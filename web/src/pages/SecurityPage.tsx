import {
  Check,
  CircleAlert,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  LogOut,
  MonitorSmartphone,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Tablet,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { ApiError, ErrorCodes, api, errorMessage } from '../api/client';
import type { SessionsResponse, TwoFactorSetup } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorNotice } from '../components/EmptyState';
import { QrCode } from '../components/QrCode';
import { useAuth } from '../lib/auth';
import { copyText, downloadText } from '../lib/browser';
import { formatAgo, formatDateTime } from '../lib/format';
import { useDocumentTitle, useResource, type ResourceState } from '../lib/hooks';
import { describeUserAgent, type DeviceKind } from '../lib/ua';
import './SecurityPage.css';

export function SecurityPage() {
  useDocumentTitle('Безопасность');
  const { auth, refresh } = useAuth();

  if (auth.status === 'loading') {
    return (
      <div className="center-state" aria-busy="true">
        <div className="spinner" aria-label="Загрузка" />
      </div>
    );
  }
  if (auth.status === 'anon') return <Navigate to="/login?next=%2Fsettings%2Fsecurity" replace />;
  if (auth.status === 'error') {
    return (
      <div className="page">
        <ErrorNotice title="Не удалось проверить вход" message={auth.message} onRetry={() => void refresh()} />
      </div>
    );
  }
  return <Security username={auth.user.username} />;
}

function Security({ username }: { username: string }) {
  const sessions = useResource((signal) => api.sessions(signal), 'sessions');
  return (
    <div className="page sec">
      <div className="sec__head">
        <h1 className="h-page">Безопасность</h1>
        <p className="muted sec__sub">Пароль, вход по коду из приложения и устройства, где открыт аккаунт.</p>
      </div>
      <div className="sec__grid">
        <TwoFactorPanel username={username} />
        <PasswordPanel onChanged={sessions.reload} />
        <SessionsPanel res={sessions} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- password

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  error?: string | null;
  hint?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="auth__password">
        <input
          id={id}
          className="input"
          type={shown ? 'text' : 'password'}
          value={value}
          maxLength={128}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined}
        />
        <button
          type="button"
          className="auth__reveal"
          onClick={() => setShown((v) => !v)}
          aria-pressed={shown}
          aria-label={shown ? `Скрыть: ${label}` : `Показать: ${label}`}
        >
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      </div>
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={`${id}-err`}>
          <CircleAlert aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PasswordPanel({ onChanged }: { onChanged: () => void }) {
  const ids = { current: useId(), next: useId(), confirm: useId() };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setDone(false);
    const found: typeof errors = {};
    if (!current) found.current = 'Введите текущий пароль.';
    if (next.length < 8) found.next = 'Новый пароль должен быть не короче 8 символов.';
    else if (next.length > 128) found.next = 'Не длиннее 128 символов.';
    else if (next === current) found.next = 'Новый пароль совпадает с текущим.';
    if (!found.next && confirm !== next) found.confirm = 'Пароли не совпадают.';
    setErrors(found);
    const first = (['current', 'next', 'confirm'] as const).find((k) => found[k]);
    if (first) {
      document.getElementById(ids[first])?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCodes.invalidCredentials) {
        setErrors({ current: 'Текущий пароль введён неверно.' });
        document.getElementById(ids.current)?.focus();
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel sec__panel" aria-labelledby="pw-h">
      <div className="sec__panel-head">
        <span className="sec__icon" aria-hidden="true">
          <KeyRound />
        </span>
        <div>
          <h2 className="h-section" id="pw-h">
            Пароль
          </h2>
          <p className="panel__lede">После смены пароля все остальные устройства выйдут из аккаунта.</p>
        </div>
      </div>
      <form ref={formRef} className="sec__form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <PasswordField
          id={ids.current}
          label="Текущий пароль"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          error={errors.current}
        />
        <PasswordField
          id={ids.next}
          label="Новый пароль"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          error={errors.next}
          hint="Не короче 8 символов."
        />
        <PasswordField
          id={ids.confirm}
          label="Новый пароль ещё раз"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          error={errors.confirm}
        />
        {formError ? (
          <div className="notice notice--error" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div className="notice__body">{formError}</div>
          </div>
        ) : null}
        <div className="sec__actions">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            Сменить пароль
          </button>
          <span className="sec__ok" role="status" aria-live="polite">
            {done ? (
              <>
                <Check aria-hidden="true" />
                Пароль изменён, другие устройства вышли из аккаунта
              </>
            ) : null}
          </span>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- 2FA

type TwoFaPhase =
  | { kind: 'off' }
  | { kind: 'setup'; setup: TwoFactorSetup }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'on' };

function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/** 400 validation_failed / 401 totp_invalid on enable/disable both mean "wrong code". */
function isWrongCode(err: unknown): boolean {
  return (
    err instanceof ApiError && (err.code === ErrorCodes.totpInvalid || err.code === ErrorCodes.validationFailed)
  );
}

function TwoFactorPanel({ username }: { username: string }) {
  const { refresh } = useAuth();
  const status = useResource((signal) => api.twoFactor(signal), '2fa');
  const [phase, setPhase] = useState<TwoFaPhase | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  const current: TwoFaPhase | null = phase ?? (status.data ? { kind: status.data.enabled ? 'on' : 'off' } : null);

  const go = (next: TwoFaPhase) => {
    setPhase(next);
    // Move focus to the panel heading so screen readers hear the new step.
    window.requestAnimationFrame(() => headRef.current?.focus());
  };

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      go({ kind: 'setup', setup: await api.twoFactorSetup() });
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const on = current?.kind === 'on' || current?.kind === 'codes';

  return (
    <section className="panel sec__panel sec__panel--2fa" data-on={on ? 'true' : 'false'} aria-labelledby="tfa-h">
      <div className="sec__panel-head">
        <span className="sec__icon sec__icon--2fa" aria-hidden="true">
          {on ? <ShieldCheck /> : <ShieldOff />}
        </span>
        <div>
          <h2 className="h-section" id="tfa-h" ref={headRef} tabIndex={-1}>
            Вход по коду из приложения
          </h2>
          <p className="panel__lede">
            Двухфакторная защита: кроме пароля, при входе понадобится код из Google Authenticator, Aegis, 1Password
            или другого приложения.
          </p>
        </div>
        {current ? (
          <span className={`chip sec__state${on ? ' sec__state--on' : ''}`}>{on ? 'Включена' : 'Выключена'}</span>
        ) : null}
      </div>

      {current === null ? (
        status.error ? (
          <ErrorNotice title="Статус не загрузился" message={errorMessage(status.error)} onRetry={status.reload} />
        ) : (
          <div className="skeleton" style={{ height: 44, width: 200 }} />
        )
      ) : current.kind === 'off' ? (
        <div className="sec__body">
          <p className="sec__text">
            Даже если пароль утечёт, без телефона войти в аккаунт и сбросить ключ трансляции не получится.
          </p>
          {startError ? (
            <p className="field__error" role="alert">
              <TriangleAlert aria-hidden="true" />
              {startError}
            </p>
          ) : null}
          <div>
            <button type="button" className="btn btn--primary" onClick={() => void start()} disabled={starting}>
              {starting ? <span className="spinner spinner--sm" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
              Включить защиту
            </button>
          </div>
        </div>
      ) : current.kind === 'setup' ? (
        <SetupStep
          setup={current.setup}
          onCancel={() => go({ kind: 'off' })}
          onEnabled={(codes) => {
            go({ kind: 'codes', codes });
            void refresh();
          }}
        />
      ) : current.kind === 'codes' ? (
        <RecoveryCodes username={username} codes={current.codes} onDone={() => go({ kind: 'on' })} />
      ) : (
        <DisableStep
          onDisabled={() => {
            go({ kind: 'off' });
            status.mutate(() => ({ enabled: false }));
            void refresh();
          }}
        />
      )}
    </section>
  );
}

function CodeInput({
  id,
  value,
  onChange,
  error,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  disabled?: boolean;
}) {
  return (
    <input
      id={id}
      className="input sec__code"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D+/g, '').slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder="000000"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-err` : undefined}
      disabled={disabled}
    />
  );
}

function SetupStep({
  setup,
  onCancel,
  onEnabled,
}: {
  setup: TwoFactorSetup;
  onCancel: () => void;
  onEnabled: (codes: string[]) => void;
}) {
  const codeId = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyCopied, setKeyCopied] = useState<'ok' | 'fail' | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Введите 6 цифр из приложения.');
      document.getElementById(codeId)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.twoFactorEnable(code);
      onEnabled(res.recoveryCodes);
    } catch (err) {
      setBusy(false);
      setError(
        isWrongCode(err)
          ? 'Код не подошёл. Проверьте время на телефоне и введите новый код.'
          : errorMessage(err),
      );
      setCode('');
      document.getElementById(codeId)?.focus();
    }
  };

  return (
    <div className="sec__body">
      <ol className="steps sec__steps">
        <li>
          <p>
            <b>Отсканируйте QR-код</b> в приложении-аутентификаторе.
          </p>
          <div className="sec__qr">
            <QrCode value={setup.otpauthUrl} label="QR-код для приложения-аутентификатора" />
            <div className="sec__manual">
              <p className="field__hint">Не получается отсканировать? Введите ключ вручную, тип — «по времени».</p>
              <code className="sec__secret num">
                {groupSecret(setup.secret)}
              </code>
              <button
                type="button"
                className="btn btn--outline btn--sm"
                onClick={() => void copyText(setup.secret).then((ok) => setKeyCopied(ok ? 'ok' : 'fail'))}
              >
                {keyCopied === 'ok' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {keyCopied === 'ok' ? 'Ключ скопирован' : 'Скопировать ключ'}
              </button>
              <span className="visually-hidden" role="status" aria-live="polite">
                {keyCopied === 'ok' ? 'Ключ скопирован' : keyCopied === 'fail' ? 'Не удалось скопировать' : ''}
              </span>
            </div>
          </div>
        </li>
        <li>
          <p>
            <b>Введите код</b>, который показало приложение.
          </p>
          <form className="sec__codeform" onSubmit={(e) => void onSubmit(e)} noValidate>
            <label className="visually-hidden" htmlFor={codeId}>
              Код из приложения
            </label>
            <CodeInput id={codeId} value={code} onChange={setCode} error={error} disabled={busy} />
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
              Включить
            </button>
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
              Отмена
            </button>
          </form>
          {error ? (
            <p className="field__error" id={`${codeId}-err`} role="alert">
              <CircleAlert aria-hidden="true" />
              {error}
            </p>
          ) : null}
        </li>
      </ol>
    </div>
  );
}

function RecoveryCodes({ username, codes, onDone }: { username: string; codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const checkId = useId();

  // The codes are shown once: warn before leaving the page until they're saved.
  useEffect(() => {
    if (saved) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [saved]);

  const text = [
    `StreamHub: резервные коды для @${username}`,
    `Созданы: ${formatDateTime(new Date().toISOString())}`,
    '',
    'Каждый код можно использовать для входа один раз, если нет доступа к приложению-аутентификатору.',
    '',
    ...codes,
    '',
  ].join('\n');

  return (
    <div className="sec__body">
      <div className="notice notice--warn" role="status">
        <TriangleAlert aria-hidden="true" />
        <div className="notice__body">
          <strong>Сохраните резервные коды — больше мы их не покажем</strong>
          <span>
            Если телефон потеряется, войти можно будет только с ними. Каждый код срабатывает один раз.
          </span>
        </div>
      </div>
      <ul className="sec__codes" aria-label="Резервные коды">
        {codes.map((c) => (
          <li key={c} className="num">
            {c}
          </li>
        ))}
      </ul>
      <div className="sec__codes-actions">
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => void copyText(codes.join('\n')).then((ok) => setCopied(ok ? 'ok' : 'fail'))}
        >
          {copied === 'ok' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied === 'ok' ? 'Скопировано' : 'Скопировать'}
        </button>
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => downloadText(`streamhub-recovery-codes-${username}.txt`, text)}
        >
          <Download aria-hidden="true" />
          Скачать .txt
        </button>
        <span className="visually-hidden" role="status" aria-live="polite">
          {copied === 'ok' ? 'Коды скопированы' : copied === 'fail' ? 'Не удалось скопировать' : ''}
        </span>
      </div>
      {copied === 'fail' ? (
        <p className="field__error">Не удалось скопировать — выделите коды и скопируйте вручную.</p>
      ) : null}
      <label className="checkbox" htmlFor={checkId}>
        <input id={checkId} type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        Я сохранил коды в надёжном месте
      </label>
      <div>
        <button type="button" className="btn btn--primary" disabled={!saved} onClick={onDone}>
          Готово
        </button>
      </div>
    </div>
  );
}

function DisableStep({ onDisabled }: { onDisabled: () => void }) {
  const ids = { password: useId(), code: useId() };
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Введите пароль.');
      document.getElementById(ids.password)?.focus();
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError('Введите 6 цифр из приложения.');
      document.getElementById(ids.code)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.twoFactorDisable({ password, code });
      onDisabled();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === ErrorCodes.invalidCredentials) {
        setError('Пароль введён неверно.');
        document.getElementById(ids.password)?.focus();
      } else if (isWrongCode(err)) {
        setError(err instanceof ApiError && err.message ? err.message : 'Пароль или код не подошли.');
        setCode('');
        document.getElementById(ids.code)?.focus();
      } else {
        setError(errorMessage(err));
      }
    }
  };

  if (!open) {
    return (
      <div className="sec__body">
        <p className="sec__text">
          При входе с нового устройства StreamHub спросит код из приложения. Если телефона нет под рукой, подойдёт
          резервный код.
        </p>
        <div>
          <button type="button" className="btn btn--danger" onClick={() => setOpen(true)}>
            <ShieldOff aria-hidden="true" />
            Отключить защиту
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="sec__body sec__form" onSubmit={(e) => void onSubmit(e)} noValidate>
      <p className="sec__text">Чтобы отключить защиту, подтвердите, что это вы.</p>
      <PasswordField
        id={ids.password}
        label="Пароль"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      <div className="field">
        <label className="field__label" htmlFor={ids.code}>
          Код из приложения
        </label>
        <CodeInput id={ids.code} value={code} onChange={setCode} error={error} disabled={busy} />
      </div>
      {error ? (
        <p className="field__error" id={`${ids.code}-err`} role="alert">
          <CircleAlert aria-hidden="true" />
          {error}
        </p>
      ) : null}
      <div className="sec__actions">
        <button type="submit" className="btn btn--danger-solid" disabled={busy}>
          {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
          Отключить
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- sessions

const DEVICE_ICON: Record<DeviceKind, ReactNode> = {
  phone: <Smartphone />,
  tablet: <Tablet />,
  desktop: <Laptop />,
  unknown: <MonitorSmartphone />,
};

function SessionsPanel({ res }: { res: ResourceState<SessionsResponse> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);
  const now = Date.now();

  const sessions = res.data?.sessions
    ? [...res.data.sessions].sort(
        (a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
      )
    : null;
  const others = sessions?.filter((s) => !s.current).length ?? 0;

  const revoke = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.revokeSession(id);
      res.mutate((prev) => (prev ? { sessions: prev.sessions.filter((s) => s.id !== id) } : prev));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const revokeAll = async () => {
    setRevokingAll(true);
    setError(null);
    try {
      await api.revokeOtherSessions();
      setConfirmOpen(false);
      res.mutate((prev) => (prev ? { sessions: prev.sessions.filter((s) => s.current) } : prev));
    } catch (err) {
      setError(errorMessage(err));
      setConfirmOpen(false);
    } finally {
      setRevokingAll(false);
    }
  };

  return (
    <section className="panel sec__panel sec__panel--wide" aria-labelledby="sess-h">
      <div className="sec__panel-head">
        <span className="sec__icon" aria-hidden="true">
          <MonitorSmartphone />
        </span>
        <div>
          <h2 className="h-section" id="sess-h">
            Устройства и сеансы
          </h2>
          <p className="panel__lede">Здесь открыт ваш аккаунт. Не узнаёте устройство — завершите сеанс и смените пароль.</p>
        </div>
        {others > 0 ? (
          <button type="button" className="btn btn--danger btn--sm sec__revoke-all" onClick={() => setConfirmOpen(true)}>
            <LogOut aria-hidden="true" />
            Завершить все остальные
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="notice notice--error sec__notice" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div className="notice__body">{error}</div>
        </div>
      ) : null}

      {sessions === null ? (
        res.error ? (
          <ErrorNotice title="Список не загрузился" message={errorMessage(res.error)} onRetry={res.reload} />
        ) : (
          <div className="sec__sessions" aria-busy="true">
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="skeleton" style={{ height: 64 }} />
            ))}
          </div>
        )
      ) : (
        <ul className="sec__sessions">
          {sessions.map((s) => {
            const d = describeUserAgent(s.userAgent);
            return (
              <li key={s.id} className="sess" data-current={s.current ? 'true' : 'false'}>
                <span className="sess__icon" aria-hidden="true">
                  {DEVICE_ICON[d.kind]}
                </span>
                <div className="sess__text">
                  <span className="sess__name">
                    {d.label}
                    {s.current ? <span className="chip sess__this">Это устройство</span> : null}
                  </span>
                  <span className="sess__meta">
                    <span className="num">{s.ip || 'IP неизвестен'}</span>
                    <span className="tile__sep" aria-hidden="true" />
                    <span>
                      {s.current ? 'активен сейчас' : `активность ${formatAgo(s.lastSeenAt, now)}`}
                    </span>
                    <span className="tile__sep" aria-hidden="true" />
                    <span>вход {formatDateTime(s.createdAt)}</span>
                  </span>
                  {s.userAgent ? (
                    <span className="sess__ua" title={s.userAgent}>
                      {s.userAgent}
                    </span>
                  ) : null}
                </div>
                {!s.current ? (
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => void revoke(s.id)}
                    disabled={busyId === s.id}
                    aria-label={`Завершить сеанс: ${d.label}, ${s.ip}`}
                  >
                    {busyId === s.id ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
                    Завершить
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {sessions && others === 0 ? <p className="muted sec__alone">Других сеансов нет — аккаунт открыт только здесь.</p> : null}
      {res.error && sessions ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={res.reload}>
          <RotateCcw aria-hidden="true" />
          Обновить список
        </button>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Завершить все остальные сеансы?"
        confirmLabel="Завершить"
        danger
        busy={revokingAll}
        onConfirm={() => void revokeAll()}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          Аккаунт останется открытым только на этом устройстве. На остальных ({others}) нужно будет войти заново.
        </p>
      </ConfirmDialog>
    </section>
  );
}
