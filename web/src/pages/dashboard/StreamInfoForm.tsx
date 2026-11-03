import { Check, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import type { ChannelPrivate, TranscodeMode } from '../../api/types';

type Values = { title: string; category: string; transcodeMode: TranscodeMode };

const CATEGORY_SUGGESTIONS = [
  'Just Chatting',
  'Игры',
  'Музыка',
  'Программирование',
  'Творчество',
  'Спорт',
  'IRL',
  'Образование',
];

const MODES: { value: TranscodeMode; title: string; text: string }[] = [
  {
    value: 'abr',
    title: 'Адаптивное качество (ABR)',
    text: 'Исходник плюс копии H.264 в меньших разрешениях. Зрители с медленным интернетом смотрят без буферизации.',
  },
  {
    value: 'passthrough',
    title: 'Без перекодирования',
    text: 'Зрители получают только исходный поток, нагрузка на сервер минимальна. Если браузеры не умеют его показывать, сервер сделает одну копию H.264.',
  },
];

function fromChannel(c: ChannelPrivate): Values {
  return { title: c.title, category: c.category, transcodeMode: c.transcodeMode };
}

function same(a: Values, b: Values) {
  return a.title === b.title && a.category === b.category && a.transcodeMode === b.transcodeMode;
}

export function StreamInfoForm({
  channel,
  isLive,
  onSaved,
}: {
  channel: ChannelPrivate;
  isLive: boolean;
  onSaved: (c: ChannelPrivate) => void;
}) {
  const ids = { title: useId(), category: useId(), list: useId() };
  const [baseline, setBaseline] = useState<Values>(() => fromChannel(channel));
  const [values, setValues] = useState<Values>(baseline);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !same(values, baseline);

  // Follow server-side changes (other tab, etc.) unless the user is editing.
  const { title, category, transcodeMode } = channel;
  useEffect(() => {
    const server = { title, category, transcodeMode };
    setBaseline((prev) => (same(prev, server) ? prev : server));
    setValues((prev) => (dirty ? prev : server));
    // `dirty` is read at the time the server value changes, intentionally not a dependency.
  }, [title, category, transcodeMode]);

  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 3000);
    return () => window.clearTimeout(t);
  }, [saved]);

  const set = <K extends keyof Values>(k: K, v: Values[K]) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const patch: Partial<Values> = {};
    if (values.title.trim() !== baseline.title) patch.title = values.title.trim();
    if (values.category.trim() !== baseline.category) patch.category = values.category.trim();
    if (values.transcodeMode !== baseline.transcodeMode) patch.transcodeMode = values.transcodeMode;
    try {
      const res = await api.patchChannel(patch);
      const next = fromChannel(res.channel);
      setBaseline(next);
      setValues(next);
      setSaved(true);
      onSaved(res.channel);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const modeChanged = values.transcodeMode !== baseline.transcodeMode;

  return (
    <section className="panel" aria-labelledby="info-h">
      <h2 className="h-section" id="info-h">
        О трансляции
      </h2>
      <p className="panel__lede">Это видят зрители в каталоге и на странице канала.</p>

      <form className="dash-form" onSubmit={(e) => void onSubmit(e)}>
        <div className="field">
          <div className="field__row">
            <label className="field__label" htmlFor={ids.title}>
              Название
            </label>
            <span className="field__counter" aria-hidden="true">
              {values.title.length}/140
            </span>
          </div>
          <input
            id={ids.title}
            className="input"
            value={values.title}
            maxLength={140}
            placeholder="Например: Собираем стрим-сервер на AV1"
            onChange={(e) => set('title', e.target.value)}
          />
        </div>

        <div className="field">
          <div className="field__row">
            <label className="field__label" htmlFor={ids.category}>
              Категория
            </label>
            <span className="field__counter" aria-hidden="true">
              {values.category.length}/40
            </span>
          </div>
          <input
            id={ids.category}
            className="input"
            value={values.category}
            maxLength={40}
            list={ids.list}
            placeholder="Just Chatting"
            onChange={(e) => set('category', e.target.value)}
          />
          <datalist id={ids.list}>
            {CATEGORY_SUGGESTIONS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>

        <fieldset className="choices">
          <legend className="field__label">Перекодирование</legend>
          {MODES.map((m) => (
            <label key={m.value} className="choice">
              <input
                type="radio"
                name="transcodeMode"
                value={m.value}
                checked={values.transcodeMode === m.value}
                onChange={() => set('transcodeMode', m.value)}
              />
              <span className="choice__title">{m.title}</span>
              <span className="choice__text">{m.text}</span>
            </label>
          ))}
        </fieldset>

        {modeChanged && isLive ? (
          <p className="dash-form__note">
            <Info aria-hidden="true" />
            Режим перекодирования применится со следующего запуска эфира.
          </p>
        ) : null}

        {error ? (
          <div className="notice notice--error" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div className="notice__body">{error}</div>
          </div>
        ) : null}

        <div className="dash-form__actions">
          <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
            {saving ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            Сохранить
          </button>
          {dirty && !saving ? (
            <button type="button" className="btn btn--ghost" onClick={() => setValues(baseline)}>
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
