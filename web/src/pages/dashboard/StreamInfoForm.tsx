import { Check, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import type { ChannelPatch, ChannelPrivate, TranscodeMode } from '../../api/types';
import { Switch } from '../../components/Switch';

type Values = {
  title: string;
  category: string;
  transcodeMode: TranscodeMode;
  lowLatency: boolean;
  saveVods: boolean;
  mature: boolean;
};

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
  return {
    title: c.title,
    category: c.category,
    transcodeMode: c.transcodeMode,
    lowLatency: Boolean(c.lowLatency),
    saveVods: c.saveVods ?? true,
    mature: Boolean(c.mature),
  };
}

function same(a: Values, b: Values) {
  return (
    a.title === b.title &&
    a.category === b.category &&
    a.transcodeMode === b.transcodeMode &&
    a.lowLatency === b.lowLatency &&
    a.saveVods === b.saveVods &&
    a.mature === b.mature
  );
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
  const { title, category, transcodeMode, lowLatency, saveVods, mature } = channel;
  useEffect(() => {
    const server = fromChannel({ ...channel, title, category, transcodeMode, lowLatency, saveVods, mature });
    setBaseline((prev) => (same(prev, server) ? prev : server));
    setValues((prev) => (dirty ? prev : server));
    // `dirty` / `channel` are read at the time the server value changes, intentionally not dependencies.
  }, [title, category, transcodeMode, lowLatency, saveVods, mature]);

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
    const patch: ChannelPatch = {};
    if (values.title.trim() !== baseline.title) patch.title = values.title.trim();
    if (values.category.trim() !== baseline.category) patch.category = values.category.trim();
    if (values.transcodeMode !== baseline.transcodeMode) patch.transcodeMode = values.transcodeMode;
    if (values.lowLatency !== baseline.lowLatency) patch.lowLatency = values.lowLatency;
    if (values.saveVods !== baseline.saveVods) patch.saveVods = values.saveVods;
    if (values.mature !== baseline.mature) patch.mature = values.mature;
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
  const latencyChanged = values.lowLatency !== baseline.lowLatency;

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

        <fieldset className="switches">
          <legend className="field__label">Настройки эфира</legend>
          <Switch
            label="Низкая задержка"
            description="Сегменты по 1 секунде: зрители видят вас через 3–4 с вместо 6–10, но на слабом интернете чаще бывает буферизация. Включается со следующего эфира."
            checked={values.lowLatency}
            onChange={(v) => set('lowLatency', v)}
          />
          <Switch
            label="Сохранять записи эфиров"
            description="После эфира запись появится на вкладке «Видео» канала, с перемоткой. Хранится ограниченное время."
            checked={values.saveVods}
            onChange={(v) => set('saveVods', v)}
          />
          <Switch
            label="Контент 18+"
            description="Перед просмотром зрители подтвердят, что им есть 18 лет. В каталоге появится отметка «18+»."
            checked={values.mature}
            onChange={(v) => set('mature', v)}
          />
        </fieldset>

        {(modeChanged || latencyChanged) && isLive ? (
          <p className="dash-form__note">
            <Info aria-hidden="true" />
            {modeChanged && latencyChanged
              ? 'Режим перекодирования и задержка применятся со следующего запуска эфира.'
              : modeChanged
                ? 'Режим перекодирования применится со следующего запуска эфира.'
                : 'Режим задержки применится со следующего запуска эфира.'}
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
