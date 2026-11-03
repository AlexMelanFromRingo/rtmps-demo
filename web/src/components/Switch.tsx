import { useId, type ReactNode } from 'react';

type Props = {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Compact: label is visually hidden (still the accessible name). */
  compact?: boolean;
  busy?: boolean;
};

/** On/off switch: a native checkbox with role="switch", label and optional explanation. */
export function Switch({ label, description, checked, onChange, disabled, compact = false, busy = false }: Props) {
  const id = useId();
  return (
    <div className={`switch${compact ? ' switch--compact' : ''}`}>
      <span className="switch__text">
        <label className={compact ? 'visually-hidden' : 'switch__label'} htmlFor={id}>
          {label}
        </label>
        {description && !compact ? (
          <span className="switch__desc" id={`${id}-d`}>
            {description}
          </span>
        ) : null}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch__input"
        checked={checked}
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-describedby={description && !compact ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}
