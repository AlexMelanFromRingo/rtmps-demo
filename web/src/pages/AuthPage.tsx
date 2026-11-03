import { ArrowLeft, CircleAlert, Eye, EyeOff, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiError, ErrorCodes, api, errorMessage } from '../api/client';
import { useAuth } from '../lib/auth';
import { useDocumentTitle } from '../lib/hooks';
import './AuthPage.css';

type Mode = 'login' | 'signup';
type Values = { username: string; password: string; displayName: string };
type Errors = Partial<Record<keyof Values, string>>;

const USERNAME_RE = /^[A-Za-z0-9_]{3,25}$/;

function validate(v: Values, mode: Mode): Errors {
  const e: Errors = {};
  if (mode === 'signup') {
    if (!v.username) e.username = 'Придумайте имя пользователя.';
    else if (v.username.length < 3 || v.username.length > 25) e.username = 'Нужно от 3 до 25 символов.';
    else if (!USERNAME_RE.test(v.username))
      e.username = 'Только латинские буквы, цифры и знак подчёркивания.';
    if (!v.password) e.password = 'Придумайте пароль.';
    else if (v.password.length < 8) e.password = 'Пароль должен быть не короче 8 символов.';
    else if (v.password.length > 128) e.password = 'Пароль должен быть не длиннее 128 символов.';
    if (v.displayName.trim().length > 40) e.displayName = 'Не длиннее 40 символов.';
  } else {
    if (!v.username) e.username = 'Введите имя пользователя.';
    if (!v.password) e.password = 'Введите пароль.';
  }
  return e;
}

/** Only allow same-app relative redirects. */
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/dashboard';
}

export function AuthPage({ mode }: { mode: Mode }) {
  const isSignup = mode === 'signup';
  useDocumentTitle(isSignup ? 'Регистрация' : 'Вход');
  const { auth, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  const [values, setValues] = useState<Values>({ username: '', password: '', displayName: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof Values, boolean>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  /** Second sign-in step: the account has two-factor authentication. */
  const [needsTotp, setNeedsTotp] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const ids = { username: useId(), password: useId(), displayName: useId(), error: useId() };

  if (auth.status === 'authed' && !submitting) return <Navigate to={next} replace />;

  const set = (key: keyof Values, value: string) => {
    const nextValues = { ...values, [key]: value };
    setValues(nextValues);
    if (touched[key]) setErrors((prev) => ({ ...prev, [key]: validate(nextValues, mode)[key] }));
  };

  const blur = (key: keyof Values) => {
    setTouched((t) => ({ ...t, [key]: true }));
    // Don't nag about empty fields on blur; only check what was typed.
    if (values[key]) setErrors((prev) => ({ ...prev, [key]: validate(values, mode)[key] }));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const found = validate(values, mode);
    setErrors(found);
    setTouched({ username: true, password: true, displayName: true });
    const firstInvalid = (['username', 'displayName', 'password'] as const).find((k) => found[k]);
    if (firstInvalid) {
      formRef.current?.querySelector<HTMLInputElement>(`[name="${firstInvalid}"]`)?.focus();
      return;
    }

    setSubmitting(true);
    try {
      if (isSignup) {
        const displayName = values.displayName.trim();
        await api.register({
          username: values.username,
          password: values.password,
          ...(displayName ? { displayName } : {}),
        });
      } else {
        await api.login({ username: values.username.trim(), password: values.password });
      }
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        if (err.code === 'username_taken') {
          setErrors((p) => ({ ...p, username: 'Это имя уже занято — выберите другое.' }));
          formRef.current?.querySelector<HTMLInputElement>('[name="username"]')?.focus();
          return;
        }
        if (err.code === ErrorCodes.invalidCredentials) {
          setFormError('Неверное имя пользователя или пароль.');
          return;
        }
        if (err.code === ErrorCodes.totpRequired) {
          setNeedsTotp(true);
          return;
        }
      }
      setFormError(errorMessage(err));
    }
  };

  const fieldError = (key: keyof Values) =>
    errors[key] ? (
      <p className="field__error" id={`${ids[key]}-err`}>
        <CircleAlert aria-hidden="true" />
        {errors[key]}
      </p>
    ) : null;

  const describedBy = (key: keyof Values, hint?: boolean) =>
    [hint ? `${ids[key]}-hint` : '', errors[key] ? `${ids[key]}-err` : ''].filter(Boolean).join(' ') ||
    undefined;

  const channelPreview = `${window.location.host}/${values.username || 'имя'}`;

  if (!isSignup && needsTotp) {
    return (
      <TotpStep
        username={values.username.trim()}
        password={values.password}
        onBack={(message) => {
          setNeedsTotp(false);
          setFormError(message);
        }}
        onDone={async () => {
          setSubmitting(true);
          await refresh();
          navigate(next, { replace: true });
        }}
      />
    );
  }

  return (
    <div className="page auth">
      <div className="auth__card">
        <h1 className="h-page">{isSignup ? 'Создать канал' : 'Вход'}</h1>
        <p className="auth__lede muted">
          {isSignup
            ? 'Аккаунт сразу получает свой канал и ключ трансляции.'
            : 'Войдите, чтобы открыть студию и начать эфир.'}
        </p>

        {formError ? (
          <div className="notice notice--error" role="alert" id={ids.error}>
            <TriangleAlert aria-hidden="true" />
            <div className="notice__body">{formError}</div>
          </div>
        ) : null}

        <form ref={formRef} className="auth__form" onSubmit={(e) => void onSubmit(e)} noValidate>
          <div className="field">
            <label className="field__label" htmlFor={ids.username}>
              Имя пользователя
            </label>
            <input
              id={ids.username}
              name="username"
              className="input"
              value={values.username}
              onChange={(e) => set('username', e.target.value)}
              onBlur={() => blur('username')}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={isSignup ? 25 : 64}
              required
              aria-invalid={errors.username ? true : undefined}
              aria-describedby={describedBy('username', isSignup)}
            />
            {isSignup ? (
              <p className="field__hint" id={`${ids.username}-hint`}>
                Латиница, цифры и _, от 3 до 25 символов. Адрес канала:{' '}
                <span className="auth__url">{channelPreview}</span>
              </p>
            ) : null}
            {fieldError('username')}
          </div>

          {isSignup ? (
            <div className="field">
              <label className="field__label" htmlFor={ids.displayName}>
                Отображаемое имя <span className="field__optional">(необязательно)</span>
              </label>
              <input
                id={ids.displayName}
                name="displayName"
                className="input"
                value={values.displayName}
                onChange={(e) => set('displayName', e.target.value)}
                onBlur={() => blur('displayName')}
                autoComplete="nickname"
                maxLength={40}
                aria-invalid={errors.displayName ? true : undefined}
                aria-describedby={describedBy('displayName', true)}
              />
              <p className="field__hint" id={`${ids.displayName}-hint`}>
                Так вас увидят зрители. Можно по-русски и с пробелами, до 40 символов.
              </p>
              {fieldError('displayName')}
            </div>
          ) : null}

          <div className="field">
            <label className="field__label" htmlFor={ids.password}>
              Пароль
            </label>
            <div className="auth__password">
              <input
                id={ids.password}
                name="password"
                className="input"
                type={showPassword ? 'text' : 'password'}
                value={values.password}
                onChange={(e) => set('password', e.target.value)}
                onBlur={() => blur('password')}
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                maxLength={128}
                required
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={describedBy('password', isSignup)}
              />
              <button
                type="button"
                className="auth__reveal"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
                aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              >
                {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
            {isSignup ? (
              <p className="field__hint" id={`${ids.password}-hint`}>
                Не короче 8 символов.
              </p>
            ) : null}
            {fieldError('password')}
          </div>

          <button type="submit" className="btn btn--primary btn--block auth__submit" disabled={submitting}>
            {submitting ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            {isSignup ? 'Создать канал' : 'Войти'}
          </button>
        </form>

        <p className="auth__switch muted">
          {isSignup ? (
            <>
              Уже есть аккаунт? <Link to={`/login${params.toString() ? `?${params}` : ''}`}>Войти</Link>
            </>
          ) : (
            <>
              Ещё нет канала? <Link to={`/signup${params.toString() ? `?${params}` : ''}`}>Создать канал</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

type TotpProps = {
  username: string;
  password: string;
  /** Back to the password step, optionally with a message for it. */
  onBack: (message: string | null) => void;
  onDone: () => Promise<void>;
};

const TOTP_RE = /^\d{6}$/;

/** Sign-in step 2: a 6-digit code from the authenticator app, or a one-time recovery code. */
function TotpStep({ username, password, onBack, onDone }: TotpProps) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const ids = { code: useId(), hint: useId(), err: useId() };

  useEffect(() => {
    inputRef.current?.focus();
  }, [recovery]);

  const normalized = recovery ? code.trim() : code.replace(/\s+/g, '');

  const submit = async (value: string) => {
    if (busy) return;
    if (!recovery && !TOTP_RE.test(value)) {
      setError('Введите 6 цифр из приложения.');
      inputRef.current?.focus();
      return;
    }
    if (recovery && value.length < 4) {
      setError('Введите резервный код целиком.');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.login({ username, password, totp: value });
      await onDone();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        if (err.code === ErrorCodes.totpInvalid) {
          setError(
            recovery
              ? 'Резервный код не подошёл. Каждый код срабатывает только один раз.'
              : 'Код не подошёл. Проверьте, что время на телефоне выставлено автоматически, и введите новый код.',
          );
          setCode('');
          inputRef.current?.focus();
          return;
        }
        if (err.code === ErrorCodes.invalidCredentials) {
          onBack('Неверное имя пользователя или пароль.');
          return;
        }
      }
      setError(errorMessage(err));
    }
  };

  return (
    <div className="page auth">
      <div className="auth__card">
        <span className="auth__badge" aria-hidden="true">
          <ShieldCheck />
        </span>
        <h1 className="h-page" ref={headRef}>
          Подтвердите вход
        </h1>
        <p className="auth__lede muted">
          {recovery
            ? 'Введите один из резервных кодов, которые вы сохранили при включении защиты.'
            : 'Откройте приложение-аутентификатор и введите код для StreamHub.'}
        </p>

        <form
          className="auth__form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit(normalized);
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor={ids.code}>
              {recovery ? 'Резервный код' : 'Код из приложения'}
            </label>
            <input
              ref={inputRef}
              key={recovery ? 'recovery' : 'totp'}
              id={ids.code}
              name="totp"
              className={`input${recovery ? '' : ' auth__code'}`}
              value={code}
              onChange={(e) => {
                const v = recovery ? e.target.value : e.target.value.replace(/\D+/g, '').slice(0, 6);
                setCode(v);
                if (error) setError(null);
                // Six digits is a complete code: submit right away.
                if (!recovery && v.length === 6) void submit(v);
              }}
              inputMode={recovery ? 'text' : 'numeric'}
              autoComplete={recovery ? 'off' : 'one-time-code'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={recovery ? 32 : 6}
              placeholder={recovery ? 'xxxx-xxxx' : '000000'}
              aria-invalid={error ? true : undefined}
              aria-describedby={[ids.hint, error ? ids.err : ''].filter(Boolean).join(' ')}
              disabled={busy}
            />
            <p className="field__hint" id={ids.hint}>
              {recovery ? 'Код можно ввести с дефисом или без.' : 'Код обновляется каждые 30 секунд.'}
            </p>
            {error ? (
              <p className="field__error" id={ids.err} role="alert">
                <CircleAlert aria-hidden="true" />
                {error}
              </p>
            ) : null}
          </div>

          <button type="submit" className="btn btn--primary btn--block auth__submit" disabled={busy}>
            {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            Подтвердить
          </button>
        </form>

        <div className="auth__alt">
          <button
            type="button"
            className="auth__linkbtn"
            onClick={() => {
              setRecovery((r) => !r);
              setCode('');
              setError(null);
            }}
          >
            {recovery ? 'Ввести код из приложения' : 'Использовать резервный код'}
          </button>
          <button type="button" className="auth__linkbtn auth__back" onClick={() => onBack(null)}>
            <ArrowLeft aria-hidden="true" />
            Назад
          </button>
        </div>
      </div>
    </div>
  );
}
