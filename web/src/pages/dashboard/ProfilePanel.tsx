import { Check, CircleAlert, ImagePlus, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ApiError, ErrorCodes, api, errorMessage } from '../../api/client';
import type { AvatarContentType, ChannelLink, ChannelPrivate } from '../../api/types';
import { Avatar } from '../../components/Avatar';

const BIO_MAX = 300;
const LINKS_MAX = 5;
const LABEL_MAX = 40;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_SIDE = 512;
const AVATAR_TYPES: AvatarContentType[] = ['image/png', 'image/jpeg', 'image/webp'];

type LinkDraft = { key: number; label: string; url: string };
type LinkErrors = Record<number, { label?: string; url?: string }>;

function validateLink(l: LinkDraft): { label?: string; url?: string } {
  const e: { label?: string; url?: string } = {};
  const url = l.url.trim();
  if (!url) e.url = 'Вставьте адрес.';
  else if (!/^https:\/\//i.test(url)) e.url = 'Только ссылки, начинающиеся с https://';
  else {
    try {
      const u = new URL(url);
      if (!u.hostname.includes('.')) e.url = 'Похоже, в адресе опечатка.';
    } catch {
      e.url = 'Похоже, в адресе опечатка.';
    }
  }
  if (l.label.trim().length > LABEL_MAX) e.label = `Не длиннее ${LABEL_MAX} символов.`;
  return e;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').slice(0, LABEL_MAX);
  } catch {
    return '';
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Centre-crops to a square and downscales to ≤512 px. Re-encoding also strips EXIF.
 * Falls back to JPEG when the browser can't encode the original type or it's still too big.
 */
async function prepareAvatar(file: File): Promise<{ contentType: AvatarContentType; blob: Blob }> {
  const img = await decode(file);
  const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const side = Math.min(w, h);
  const out = Math.min(AVATAR_SIDE, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
  if ('close' in img) img.close();

  let blob = await canvasBlob(canvas, file.type, 0.9);
  if (!blob || !AVATAR_TYPES.includes(blob.type as AvatarContentType) || blob.size > AVATAR_MAX_BYTES) {
    blob = await canvasBlob(canvas, 'image/jpeg', 0.86);
  }
  if (!blob) throw new Error('encode');
  return { contentType: blob.type as AvatarContentType, blob };
}

export function ProfilePanel({
  channel,
  onSaved,
  onAvatar,
}: {
  channel: ChannelPrivate;
  onSaved: (c: ChannelPrivate) => void;
  onAvatar: (avatarUrl: string | null) => void;
}) {
  const ids = { bio: useId() };
  const keyRef = useRef(0);
  const toDrafts = (links: ChannelLink[]): LinkDraft[] =>
    links.map((l) => ({ key: ++keyRef.current, label: l.label, url: l.url }));

  const [bio, setBio] = useState(channel.bio ?? '');
  const [links, setLinks] = useState<LinkDraft[]>(() => toDrafts(channel.links ?? []));
  const [baseline, setBaseline] = useState(() => JSON.stringify({ bio: channel.bio ?? '', links: channel.links ?? [] }));
  const [linkErrors, setLinkErrors] = useState<LinkErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = JSON.stringify({
    bio,
    links: links.map((l) => ({ label: l.label, url: l.url })),
  });
  const dirty = current !== baseline;

  // Follow server-side changes unless the streamer is editing.
  const serverJson = JSON.stringify({ bio: channel.bio ?? '', links: channel.links ?? [] });
  useEffect(() => {
    if (serverJson === baseline) return;
    setBaseline(serverJson);
    if (!dirty) {
      const parsed = JSON.parse(serverJson) as { bio: string; links: ChannelLink[] };
      setBio(parsed.bio);
      setLinks(toDrafts(parsed.links));
    }
    // Only react to the server value.
  }, [serverJson]);

  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 3000);
    return () => window.clearTimeout(t);
  }, [saved]);

  const updateLink = (key: number, patch: Partial<LinkDraft>) => {
    setLinks((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setSaved(false);
    if (linkErrors[key]) setLinkErrors((e) => ({ ...e, [key]: {} }));
  };

  const addLink = () => {
    if (links.length >= LINKS_MAX) return;
    const key = ++keyRef.current;
    setLinks((ls) => [...ls, { key, label: '', url: 'https://' }]);
    window.requestAnimationFrame(() => document.getElementById(`link-url-${key}`)?.focus());
  };

  const removeLink = (key: number, index: number) => {
    setLinks((ls) => ls.filter((l) => l.key !== key));
    setSaved(false);
    // Keep keyboard focus in the list.
    window.requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLInputElement>('.links__url');
      (rows[Math.min(index, rows.length - 1)] ?? document.getElementById('links-add'))?.focus();
    });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || saving) return;
    // Drop untouched empty rows, then validate.
    const kept = links.filter((l) => l.url.trim() && l.url.trim() !== 'https://');
    const errs: LinkErrors = {};
    kept.forEach((l) => {
      const v = validateLink(l);
      if (v.url || v.label) errs[l.key] = v;
    });
    setLinkErrors(errs);
    const firstBad = kept.find((l) => errs[l.key]);
    if (firstBad) {
      document.getElementById(`link-${errs[firstBad.key]?.url ? 'url' : 'label'}-${firstBad.key}`)?.focus();
      return;
    }
    const payload = kept.map((l) => ({ label: l.label.trim() || hostLabel(l.url.trim()), url: l.url.trim() }));
    setSaving(true);
    setError(null);
    try {
      const res = await api.patchChannel({ bio: bio.trim(), links: payload });
      const next = { bio: res.channel.bio ?? '', links: res.channel.links ?? [] };
      setBaseline(JSON.stringify(next));
      setBio(next.bio);
      setLinks(toDrafts(next.links));
      setSaved(true);
      onSaved(res.channel);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel" id="profile" aria-labelledby="profile-h">
      <h2 className="h-section" id="profile-h">
        Профиль канала
      </h2>
      <p className="panel__lede">Аватар, описание и ссылки видят зрители на странице канала и в поиске.</p>

      <AvatarEditor channel={channel} onAvatar={onAvatar} />

      <form className="dash-form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="field">
          <div className="field__row">
            <label className="field__label" htmlFor={ids.bio}>
              О канале
            </label>
            <span className="field__counter" aria-hidden="true">
              {bio.length}/{BIO_MAX}
            </span>
          </div>
          <textarea
            id={ids.bio}
            className="input"
            value={bio}
            maxLength={BIO_MAX}
            rows={4}
            placeholder="Про что ваши эфиры, когда вы обычно в эфире"
            onChange={(e) => {
              setBio(e.target.value);
              setSaved(false);
            }}
          />
        </div>

        <fieldset className="links">
          <legend className="field__label">
            Ссылки <span className="field__optional">(до {LINKS_MAX}, только https)</span>
          </legend>
          {links.length ? (
            <ul className="links__list">
              {links.map((l, i) => {
                const err = linkErrors[l.key] ?? {};
                return (
                  <li key={l.key} className="links__row">
                    <div className="field links__label">
                      <label className="visually-hidden" htmlFor={`link-label-${l.key}`}>
                        Подпись ссылки {i + 1}
                      </label>
                      <input
                        id={`link-label-${l.key}`}
                        className="input"
                        value={l.label}
                        maxLength={LABEL_MAX}
                        placeholder={hostLabel(l.url) || 'Подпись'}
                        onChange={(e) => updateLink(l.key, { label: e.target.value })}
                        aria-invalid={err.label ? true : undefined}
                        aria-describedby={err.label ? `link-label-${l.key}-err` : undefined}
                      />
                      {err.label ? (
                        <p className="field__error" id={`link-label-${l.key}-err`}>
                          <CircleAlert aria-hidden="true" />
                          {err.label}
                        </p>
                      ) : null}
                    </div>
                    <div className="field links__urlfield">
                      <label className="visually-hidden" htmlFor={`link-url-${l.key}`}>
                        Адрес ссылки {i + 1}
                      </label>
                      <input
                        id={`link-url-${l.key}`}
                        className="input links__url"
                        type="url"
                        inputMode="url"
                        value={l.url}
                        maxLength={300}
                        spellCheck={false}
                        autoCapitalize="none"
                        placeholder="https://"
                        onChange={(e) =>
                          // A URL pasted after the prefilled "https://" shouldn't end up with two schemes.
                          updateLink(l.key, { url: e.target.value.replace(/^https:\/\/(?=[a-z][a-z0-9+.-]*:\/\/)/i, '') })
                        }
                        aria-invalid={err.url ? true : undefined}
                        aria-describedby={err.url ? `link-url-${l.key}-err` : undefined}
                      />
                      {err.url ? (
                        <p className="field__error" id={`link-url-${l.key}-err`}>
                          <CircleAlert aria-hidden="true" />
                          {err.url}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon links__remove"
                      onClick={() => removeLink(l.key, i)}
                      aria-label={`Убрать ссылку ${i + 1}`}
                      title="Убрать"
                    >
                      <X aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {links.length < LINKS_MAX ? (
            <button type="button" id="links-add" className="btn btn--outline btn--sm links__add" onClick={addLink}>
              <Plus aria-hidden="true" />
              Добавить ссылку
            </button>
          ) : (
            <p className="field__hint">Это максимум — 5 ссылок.</p>
          )}
        </fieldset>

        {error ? (
          <div className="notice notice--error" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div className="notice__body">{error}</div>
          </div>
        ) : null}

        <div className="dash-form__actions">
          <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
            {saving ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            Сохранить профиль
          </button>
          {dirty && !saving ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                const parsed = JSON.parse(baseline) as { bio: string; links: ChannelLink[] };
                setBio(parsed.bio);
                setLinks(toDrafts(parsed.links));
                setLinkErrors({});
              }}
            >
              Отменить
            </button>
          ) : null}
          <span className="dash-form__saved" role="status" aria-live="polite">
            {saved ? (
              <>
                <Check aria-hidden="true" />
                Сохранено
              </>
            ) : null}
          </span>
        </div>
      </form>
    </section>
  );
}

function AvatarEditor({ channel, onAvatar }: { channel: ChannelPrivate; onAvatar: (url: string | null) => void }) {
  const fileId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'upload' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setStatus(null);
    if (!AVATAR_TYPES.includes(file.type as AvatarContentType)) {
      setError('Нужен файл PNG, JPEG или WebP.');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError('Файл больше 2 МБ — выберите изображение поменьше.');
      return;
    }
    setBusy('upload');
    try {
      const { contentType, blob } = await prepareAvatar(file);
      setPreview(URL.createObjectURL(blob));
      const data = await blobToBase64(blob);
      const res = await api.uploadAvatar(contentType, data);
      onAvatar(res.avatarUrl);
      setStatus('Аватар обновлён');
    } catch (err) {
      setPreview(null);
      if (err instanceof ApiError && err.code === ErrorCodes.payloadTooLarge) {
        setError('Сервер не принял файл: он слишком большой.');
      } else if (err instanceof ApiError) {
        setError(errorMessage(err));
      } else {
        setError('Не удалось прочитать изображение. Попробуйте другой файл.');
      }
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    setBusy('delete');
    setError(null);
    setStatus(null);
    try {
      await api.deleteAvatar();
      setPreview(null);
      onAvatar(null);
      setStatus('Аватар удалён');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const shown = { ...channel, avatarUrl: preview ?? channel.avatarUrl };

  return (
    <div className="avedit">
      <div className="avedit__pic" data-busy={busy === 'upload' ? 'true' : 'false'}>
        <Avatar channel={shown} size={88} />
        {busy === 'upload' ? <span className="spinner avedit__spin" aria-hidden="true" /> : null}
      </div>
      <div className="avedit__body">
        <div className="avedit__actions">
          <input
            ref={inputRef}
            id={fileId}
            type="file"
            accept={AVATAR_TYPES.join(',')}
            className="visually-hidden"
            onChange={(e) => void onFile(e)}
            aria-describedby={hintId}
            disabled={busy !== null}
          />
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null}
          >
            <ImagePlus aria-hidden="true" />
            {channel.avatarUrl ? 'Заменить аватар' : 'Загрузить аватар'}
          </button>
          {channel.avatarUrl ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void onDelete()}
              disabled={busy !== null}
            >
              {busy === 'delete' ? <span className="spinner spinner--sm" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              Удалить
            </button>
          ) : null}
        </div>
        <p className="field__hint" id={hintId}>
          PNG, JPEG или WebP до 2 МБ. Обрежем по центру до квадрата 512×512.
        </p>
        {error ? (
          <p className="field__error" role="alert">
            <CircleAlert aria-hidden="true" />
            {error}
          </p>
        ) : null}
        <span className="dash-form__saved" role="status" aria-live="polite">
          {status ? (
            <>
              <Check aria-hidden="true" />
              {status}
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
