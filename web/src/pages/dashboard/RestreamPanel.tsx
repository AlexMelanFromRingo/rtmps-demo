import { CircleAlert, Eye, EyeOff, Info, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError, ErrorCodes, api, errorMessage } from '../../api/client';
import type {
  RestreamDestination,
  RestreamService,
  RestreamStatus,
  RestreamTranscode,
} from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorNotice } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { SERVICE_LABEL, ServiceGlyph } from '../../components/ServiceGlyph';
import { Switch } from '../../components/Switch';
import { formatAgo } from '../../lib/format';
import { useResource } from '../../lib/hooks';

const MAX_DESTINATIONS = 5;
const URL_RE = /^(rtmps?|srt):\/\/[^\s/?#]+/i;

const PRESETS: Record<Exclude<RestreamService, 'custom'>, string> = {
  twitch: 'rtmp://live.twitch.tv/app',
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  kick: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app',
};

const KEY_WHERE: Record<RestreamService, string> = {
  twitch: 'Twitch: Панель управления автора → Настройки → Трансляция → «Основной ключ трансляции».',
  youtube: 'YouTube Studio → «Начать трансляцию» → «Ключ трансляции».',
  kick: 'Kick: Dashboard → Settings → Stream URL & Key → Stream Key.',
  custom: 'Ключ (stream key) выдаёт сервер, на который вы ретранслируете.',
};

const TRANSCODE: { value: RestreamTranscode; title: string; short: string; text: string }[] = [
  {
    value: 'auto',
    title: 'Автоматически',
    short: 'Видео: авто',
    text: 'Если эфир идёт в H.264, видео уходит без перекодирования. AV1, HEVC и VP9 перекодируются в H.264 — их принимают не все сервисы.',
  },
  {
    value: 'copy',
    title: 'Без перекодирования',
    short: 'Видео: копия',
    text: 'Видео уходит как есть. Подходит, если сервис принимает кодек вашего эфира (например, YouTube принимает HEVC и AV1).',
  },
  {
    value: 'h264',
    title: 'Всегда H.264',
    short: 'Видео: H.264',
    text: 'Видео всегда перекодируется в H.264: максимальная совместимость, но нагрузка на сервер выше.',
  },
];

type Props = {
  /** Live statuses from `GET /api/dashboard` (live.stats.restreams). */
  statuses: RestreamStatus[];
  isLive: boolean;
};

export function RestreamPanel({ statuses, isLive }: Props) {
  const res = useResource((signal) => api.restreams(signal), 'restreams');
  const [editing, setEditing] = useState<RestreamDestination | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RestreamDestination | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = res.data?.destinations ?? null;
  const full = (list?.length ?? 0) >= MAX_DESTINATIONS;

  const replace = (d: RestreamDestination) =>
    res.mutate((prev) => (prev ? { destinations: prev.destinations.map((x) => (x.id === d.id ? d : x)) } : prev));

  /** Inline toggles: optimistic, reverted on failure. */
  const patchInline = async (d: RestreamDestination, patch: Partial<Pick<RestreamDestination, 'enabled' | 'transcode'>>) => {
    setRowBusy(d.id);
    setError(null);
    replace({ ...d, ...patch });
    try {
      const r = await api.updateRestream(d.id, patch);
      replace(r.destination);
    } catch (err) {
      replace(d);
      setError(`${d.name}: ${errorMessage(err)}`);
    } finally {
      setRowBusy(null);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.deleteRestream(deleting.id);
      res.mutate((prev) => (prev ? { destinations: prev.destinations.filter((x) => x.id !== deleting.id) } : prev));
      setDeleting(null);
    } catch (err) {
      setError(errorMessage(err));
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <section className="panel restream" id="multistream" aria-labelledby="restream-h">
      <div className="panel__head">
        <div>
          <h2 className="h-section" id="restream-h">
            Мультистрим
          </h2>
          <p className="panel__lede">
            Одновременно с StreamHub — на Twitch, YouTube, Kick или свой сервер. Включённые направления стартуют и
            останавливаются вместе с эфиром.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--outline btn--sm"
          onClick={() => setEditing('new')}
          disabled={!list || full}
          aria-describedby={full ? 'restream-full' : undefined}
        >
          <Plus aria-hidden="true" />
          Добавить направление
        </button>
      </div>

      {error ? (
        <div className="notice notice--error restream__notice" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div className="notice__body">{error}</div>
        </div>
      ) : null}

      {list === null ? (
        res.error ? (
          <ErrorNotice title="Направления не загрузились" message={errorMessage(res.error)} onRetry={res.reload} />
        ) : (
          <div className="skeleton" style={{ height: 72 }} aria-busy="true" />
        )
      ) : list.length === 0 ? (
        <div className="restream__empty">
          <p>
            Направлений пока нет. Добавьте сервис — ключ возьмите в его настройках трансляции, а в OBS ничего менять не
            нужно.
          </p>
        </div>
      ) : (
        <ul className="restream__list">
          {list.map((d) => (
            <RestreamRow
              key={d.id}
              d={d}
              status={statuses.find((s) => s.id === d.id) ?? null}
              isLive={isLive}
              busy={rowBusy === d.id}
              onToggle={(enabled) => void patchInline(d, { enabled })}
              onTranscode={(transcode) => void patchInline(d, { transcode })}
              onEdit={() => setEditing(d)}
              onDelete={() => setDeleting(d)}
            />
          ))}
        </ul>
      )}

      <p className="ingest__note">
        <Info aria-hidden="true" />
        <span>
          Звук всегда приводится к AAC. {full ? <span id="restream-full">Это максимум — 5 направлений.</span> : `До ${MAX_DESTINATIONS} направлений.`}
        </span>
      </p>

      <RestreamDialog
        target={editing}
        count={list?.length ?? 0}
        onClose={() => setEditing(null)}
        onSaved={(d, created) => {
          res.mutate((prev) =>
            prev
              ? { destinations: created ? [...prev.destinations, d] : prev.destinations.map((x) => (x.id === d.id ? d : x)) }
              : prev,
          );
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Удалить направление?"
        confirmLabel="Удалить"
        danger
        busy={deleteBusy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleting(null)}
      >
        <p>
          «{deleting?.name}» перестанет получать эфир{isLive ? ' — ретрансляция остановится сразу' : ''}.
          Сохранённый ключ этого сервиса удалится вместе с направлением.
        </p>
      </ConfirmDialog>
    </section>
  );
}

function StatusChip({ d, status, isLive }: { d: RestreamDestination; status: RestreamStatus | null; isLive: boolean }) {
  if (!d.enabled) return <span className="status status--offline">Выключено</span>;
  if (!isLive) return <span className="status status--offline">Запустится с эфиром</span>;
  if (!status)
    return (
      <span className="status status--standby">
        <span className="status__dot" aria-hidden="true" />
        Ожидание
      </span>
    );
  if (status.state === 'live')
    return (
      <span className="status status--live" title={`с ${formatAgo(status.since)}`}>
        <span className="status__dot" aria-hidden="true" />
        В эфире
      </span>
    );
  if (status.state === 'connecting')
    return (
      <span className="status status--standby">
        <span className="status__dot" aria-hidden="true" />
        Подключение
      </span>
    );
  return (
    <span className="status status--error">
      <CircleAlert aria-hidden="true" />
      Ошибка
    </span>
  );
}

function RestreamRow({
  d,
  status,
  isLive,
  busy,
  onToggle,
  onTranscode,
  onEdit,
  onDelete,
}: {
  d: RestreamDestination;
  status: RestreamStatus | null;
  isLive: boolean;
  busy: boolean;
  onToggle: (v: boolean) => void;
  onTranscode: (v: RestreamTranscode) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const selId = useId();
  const state = !d.enabled ? 'off' : isLive ? (status?.state ?? 'connecting') : 'idle';
  return (
    <li className="rs" data-state={state}>
      <span className="rs__glyph">
        <ServiceGlyph service={d.service} />
      </span>
      <div className="rs__main">
        <div className="rs__top">
          <span className="rs__name">{d.name}</span>
          <StatusChip d={d} status={status} isLive={isLive} />
        </div>
        <p className="rs__meta">
          <span>{SERVICE_LABEL[d.service]}</span>
          <span className="tile__sep" aria-hidden="true" />
          <span className="rs__url" title={d.url}>
            {d.url}
          </span>
          <span className="tile__sep" aria-hidden="true" />
          <span className="num">ключ {d.keyMasked}</span>
        </p>
        {d.enabled && isLive && status?.state === 'error' && status.error ? (
          <p className="rs__error" role="status">
            {status.error}
          </p>
        ) : null}
      </div>
      <div className="rs__controls">
        <label className="visually-hidden" htmlFor={selId}>
          Видео для «{d.name}»
        </label>
        <select
          id={selId}
          className="input input--sm rs__select"
          value={d.transcode}
          disabled={busy}
          onChange={(e) => onTranscode(e.target.value as RestreamTranscode)}
          title={TRANSCODE.find((t) => t.value === d.transcode)?.text}
        >
          {TRANSCODE.map((t) => (
            <option key={t.value} value={t.value}>
              {t.short}
            </option>
          ))}
        </select>
        <Switch compact label={`Ретрансляция на «${d.name}»`} checked={d.enabled} disabled={busy} busy={busy} onChange={onToggle} />
        <button type="button" className="btn btn--ghost btn--sm btn--icon" onClick={onEdit} aria-label={`Изменить «${d.name}»`} title="Изменить">
          <Pencil aria-hidden="true" />
        </button>
        <button type="button" className="btn btn--ghost btn--sm btn--icon rs__del" onClick={onDelete} aria-label={`Удалить «${d.name}»`} title="Удалить">
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

type Draft = {
  service: RestreamService;
  name: string;
  url: string;
  streamKey: string;
  transcode: RestreamTranscode;
  enabled: boolean;
};

type DraftErrors = Partial<Record<'name' | 'url' | 'streamKey', string>>;

function draftFrom(target: RestreamDestination | 'new' | null): Draft {
  if (target && target !== 'new') {
    return {
      service: target.service,
      name: target.name,
      url: target.url,
      streamKey: '',
      transcode: target.transcode,
      enabled: target.enabled,
    };
  }
  return { service: 'twitch', name: SERVICE_LABEL.twitch, url: PRESETS.twitch, streamKey: '', transcode: 'auto', enabled: true };
}

function RestreamDialog({
  target,
  count,
  onClose,
  onSaved,
}: {
  target: RestreamDestination | 'new' | null;
  count: number;
  onClose: () => void;
  onSaved: (d: RestreamDestination, created: boolean) => void;
}) {
  const isNew = target === 'new';
  const existing = target !== null && target !== 'new' ? target : null;
  const ids = { name: useId(), url: useId(), key: useId(), group: useId() };
  const [draft, setDraft] = useState<Draft>(() => draftFrom(target));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);

  // Reset whenever the dialog opens for a (new) target.
  useEffect(() => {
    if (!target) return;
    setDraft(draftFrom(target));
    setErrors({});
    setFormError(null);
    setShowKey(false);
    setNameTouched(target !== 'new');
  }, [target]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (k in errors) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const pickService = (service: RestreamService) => {
    setDraft((d) => {
      const wasPreset = d.service !== 'custom' && d.url === PRESETS[d.service];
      const url = service === 'custom' ? (wasPreset ? '' : d.url) : PRESETS[service];
      const name = nameTouched ? d.name : SERVICE_LABEL[service];
      return { ...d, service, url, name };
    });
    setErrors({});
  };

  const validate = (): DraftErrors => {
    const e: DraftErrors = {};
    const name = draft.name.trim();
    if (!name) e.name = 'Назовите направление — так оно будет подписано в списке.';
    else if (name.length > 40) e.name = 'Не длиннее 40 символов.';
    const url = draft.url.trim();
    if (!url) e.url = 'Вставьте адрес сервера.';
    else if (!URL_RE.test(url)) e.url = 'Адрес должен начинаться с rtmp://, rtmps:// или srt://';
    const key = draft.streamKey.trim();
    if (isNew && !key) e.streamKey = 'Вставьте ключ трансляции из настроек сервиса.';
    else if (/\s/.test(key)) e.streamKey = 'В ключе не должно быть пробелов.';
    return e;
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const found = validate();
    setErrors(found);
    const first = (['name', 'url', 'streamKey'] as const).find((k) => found[k]);
    if (first) {
      document.getElementById(first === 'name' ? ids.name : first === 'url' ? ids.url : ids.key)?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    const body = {
      name: draft.name.trim(),
      service: draft.service,
      url: draft.url.trim(),
      streamKey: draft.streamKey.trim(),
      enabled: draft.enabled,
      transcode: draft.transcode,
    };
    try {
      if (isNew) {
        const r = await api.createRestream(body);
        onSaved(r.destination, true);
      } else if (existing) {
        const r = await api.updateRestream(existing.id, body);
        onSaved(r.destination, false);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCodes.conflict) {
        setFormError(`Можно добавить не больше ${MAX_DESTINATIONS} направлений. Удалите ненужное.`);
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const describe = (id: string, key: keyof DraftErrors, hint = true) =>
    [hint ? `${id}-hint` : '', errors[key] ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;

  const err = (id: string, key: keyof DraftErrors) =>
    errors[key] ? (
      <p className="field__error" id={`${id}-err`}>
        <CircleAlert aria-hidden="true" />
        {errors[key]}
      </p>
    ) : null;

  const isPreset = draft.service !== 'custom';

  return (
    <Modal
      open={target !== null}
      title={existing ? `Изменить «${existing.name}»` : 'Новое направление'}
      onClose={onClose}
      busy={busy}
      wide
    >
      <form className="rsform" onSubmit={(e) => void onSubmit(e)} noValidate>
        <fieldset className="rsform__services">
          <legend className="field__label">Сервис</legend>
          <div className="rsform__seg">
            {(['twitch', 'youtube', 'kick', 'custom'] as const).map((s, i) => (
              <label key={s} className="rsform__svc">
                <input
                  type="radio"
                  name={ids.group}
                  value={s}
                  checked={draft.service === s}
                  onChange={() => pickService(s)}
                  {...(draft.service === s || (i === 0 && !draft.service) ? { 'data-autofocus': true } : {})}
                />
                <ServiceGlyph service={s} size={18} />
                {SERVICE_LABEL[s]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label className="field__label" htmlFor={ids.name}>
            Название
          </label>
          <input
            id={ids.name}
            className="input"
            value={draft.name}
            maxLength={40}
            onChange={(e) => {
              setNameTouched(true);
              set('name', e.target.value);
            }}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={describe(ids.name, 'name', false)}
          />
          {err(ids.name, 'name')}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={ids.url}>
            Адрес сервера
          </label>
          <input
            id={ids.url}
            className="input"
            value={draft.url}
            inputMode="url"
            spellCheck={false}
            autoCapitalize="none"
            placeholder="rtmp://…, rtmps://… или srt://…"
            onChange={(e) => set('url', e.target.value)}
            aria-invalid={errors.url ? true : undefined}
            aria-describedby={describe(ids.url, 'url')}
          />
          <p className="field__hint" id={`${ids.url}-hint`}>
            {isPreset
              ? `Стандартный адрес ${SERVICE_LABEL[draft.service]}. Можно заменить на ближайший к вам сервер приёма.`
              : 'Без ключа: ключ вводится отдельно ниже.'}
          </p>
          {err(ids.url, 'url')}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={ids.key}>
            Ключ трансляции
          </label>
          <div className="auth__password">
            <input
              id={ids.key}
              className="input"
              type={showKey ? 'text' : 'password'}
              value={draft.streamKey}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              placeholder={existing ? `Не меняется (${existing.keyMasked})` : ''}
              onChange={(e) => set('streamKey', e.target.value)}
              aria-invalid={errors.streamKey ? true : undefined}
              aria-describedby={describe(ids.key, 'streamKey')}
            />
            <button
              type="button"
              className="auth__reveal"
              onClick={() => setShowKey((v) => !v)}
              aria-pressed={showKey}
              aria-label={showKey ? 'Скрыть ключ' : 'Показать ключ'}
            >
              {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
          <p className="field__hint" id={`${ids.key}-hint`}>
            {isNew ? KEY_WHERE[draft.service] : 'Оставьте пустым, чтобы не менять ключ. Целиком он не показывается.'}
          </p>
          {err(ids.key, 'streamKey')}
        </div>

        <fieldset className="choices">
          <legend className="field__label">Видео</legend>
          {TRANSCODE.map((t) => (
            <label key={t.value} className="choice">
              <input
                type="radio"
                name={`${ids.group}-tx`}
                value={t.value}
                checked={draft.transcode === t.value}
                onChange={() => set('transcode', t.value)}
              />
              <span className="choice__title">{t.title}</span>
              <span className="choice__text">{t.text}</span>
            </label>
          ))}
        </fieldset>

        <Switch
          label="Включено"
          description="Выключенное направление сохраняется, но эфир на него не уходит."
          checked={draft.enabled}
          onChange={(v) => set('enabled', v)}
        />

        {formError ? (
          <div className="notice notice--error" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div className="notice__body">{formError}</div>
          </div>
        ) : null}

        {isNew && count >= MAX_DESTINATIONS ? (
          <p className="field__hint">Это максимум — 5 направлений.</p>
        ) : null}

        <div className="dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            {isNew ? 'Добавить' : 'Сохранить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
