import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { copyText } from '../lib/browser';

type Props = {
  label: string;
  value: string;
  /** When set, the value is masked until revealed. `mask` controls what is hidden. */
  secret?: boolean;
  mask?: (value: string) => string;
  hint?: string;
};

const DOTS = '•'.repeat(16);

export function CopyField({ label, value, secret = false, mask, hint }: Props) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const display = secret && !revealed ? (mask ? mask(value) : DOTS) : value;

  const onCopy = async () => {
    setCopied((await copyText(value)) ? 'ok' : 'fail');
  };

  return (
    <div className="copyfield">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="copyfield__row">
        <input
          id={id}
          className="input copyfield__input"
          readOnly
          value={display}
          spellCheck={false}
          onFocus={(e) => {
            if (!secret || revealed) e.currentTarget.select();
          }}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        {secret ? (
          <button
            type="button"
            className="btn btn--outline btn--icon"
            onClick={() => setRevealed((v) => !v)}
            aria-pressed={revealed}
            aria-label={revealed ? `Скрыть: ${label}` : `Показать: ${label}`}
            title={revealed ? 'Скрыть' : 'Показать'}
          >
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--outline copyfield__copy"
          onClick={() => void onCopy()}
          aria-label={`Копировать: ${label}`}
        >
          {copied === 'ok' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span className="copyfield__copy-text">{copied === 'ok' ? 'Скопировано' : 'Копировать'}</span>
        </button>
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied === 'ok' ? `${label}: скопировано` : copied === 'fail' ? 'Не удалось скопировать' : ''}
      </span>
      {copied === 'fail' ? (
        <p className="field__error">Не удалось скопировать — выделите текст и скопируйте вручную.</p>
      ) : null}
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
