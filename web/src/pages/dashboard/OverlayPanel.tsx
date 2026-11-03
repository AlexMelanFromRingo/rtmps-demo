import { Bell, Check, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyField } from '../../components/CopyField';
import { Switch } from '../../components/Switch';

type Options = { alerts: boolean; viewers: boolean; sound: boolean };

function buildUrl(overlayUrl: string, o: Options): string {
  const q = new URLSearchParams({
    alerts: o.alerts ? '1' : '0',
    viewers: o.viewers ? '1' : '0',
    sound: o.sound ? '1' : '0',
  });
  return `${window.location.origin}${overlayUrl}?${q}`;
}

/** Hides the secret token: "/overlay/••••••••". */
function maskToken(url: string): string {
  return url.replace(/\/overlay\/[^?#]+/, '/overlay/••••••••••••');
}

export function OverlayPanel({ overlayUrl, onReset }: { overlayUrl: string; onReset: (url: string) => void }) {
  const [opts, setOpts] = useState<Options>({ alerts: true, viewers: true, sound: true });
  const [testState, setTestState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    if (testState !== 'sent') return;
    const t = window.setTimeout(() => setTestState('idle'), 6000);
    return () => window.clearTimeout(t);
  }, [testState]);

  const url = buildUrl(overlayUrl, opts);
  const nothing = !opts.alerts && !opts.viewers;

  const sendTest = async () => {
    setTestState('busy');
    setTestError(null);
    try {
      await api.overlayTest();
      setTestState('sent');
    } catch (err) {
      setTestState('error');
      setTestError(errorMessage(err));
    }
  };

  const doReset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      const r = await api.overlayReset();
      onReset(r.overlayUrl);
      setConfirmOpen(false);
      setResetDone(true);
    } catch (err) {
      setResetError(errorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="panel overlay-panel" id="overlay" aria-labelledby="overlay-h">
      <div className="panel__head">
        <div>
          <h2 className="h-section" id="overlay-h">
            Оверлей для OBS
          </h2>
          <p className="panel__lede">Оповещения о новых подписчиках и счётчик зрителей поверх вашего эфира.</p>
        </div>
      </div>

      <div className="dash-form overlay-panel__body">
        <fieldset className="switches">
          <legend className="field__label">Что показывать</legend>
          <Switch
            label="Оповещения о подписках"
            description="Плашка «Имя подписался!» внизу слева, около 5 секунд."
            checked={opts.alerts}
            onChange={(v) => setOpts((o) => ({ ...o, alerts: v }))}
          />
          <Switch
            label="Счётчик зрителей"
            description="В правом верхнем углу, только пока идёт эфир."
            checked={opts.viewers}
            onChange={(v) => setOpts((o) => ({ ...o, viewers: v }))}
          />
          <Switch
            label="Звук оповещения"
            description="Короткий сигнал при новой подписке."
            checked={opts.sound}
            disabled={!opts.alerts}
            onChange={(v) => setOpts((o) => ({ ...o, sound: v }))}
          />
        </fieldset>

        {nothing ? (
          <p className="dash-form__note">
            <TriangleAlert aria-hidden="true" />
            Сейчас оверлей ничего не покажет — включите хотя бы одно.
          </p>
        ) : null}

        {resetDone ? (
          <div className="notice notice--warn" role="status">
            <TriangleAlert aria-hidden="true" />
            <div className="notice__body">Ссылка сброшена. Вставьте новую в OBS — старая больше не работает.</div>
          </div>
        ) : null}

        <CopyField
          label="Ссылка для источника «Браузер»"
          value={url}
          secret
          mask={maskToken}
          hint="Ссылка секретная: не показывайте её в эфире. Если она утекла — сбросьте."
        />

        <div className="overlay-panel__actions">
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => void sendTest()}
            disabled={testState === 'busy'}
          >
            {testState === 'busy' ? <span className="spinner spinner--sm" aria-hidden="true" /> : <Bell aria-hidden="true" />}
            Тестовое оповещение
          </button>
          <a className="btn btn--ghost btn--sm" href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" />
            Открыть предпросмотр
          </a>
          <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirmOpen(true)}>
            <RefreshCw aria-hidden="true" />
            Сбросить ссылку
          </button>
        </div>
        <p className="dash-form__saved overlay-panel__status" role="status" aria-live="polite">
          {testState === 'sent' ? (
            <>
              <Check aria-hidden="true" />
              Отправлено — если оверлей открыт, оповещение появится через секунду.
            </>
          ) : null}
        </p>
        {testState === 'error' && testError ? (
          <p className="field__error" role="alert">
            <TriangleAlert aria-hidden="true" />
            {testError}
          </p>
        ) : null}

        <div className="ingest__howto">
          <h3 className="ingest__howto-title">Как добавить в OBS</h3>
          <ol className="steps">
            <li>
              В OBS в панели «Источники» нажмите <b>+</b> и выберите <b>«Браузер»</b>.
            </li>
            <li>
              В поле <b>URL</b> вставьте ссылку отсюда.
            </li>
            <li>
              Ширина <b>1920</b>, высота <b>1080</b>. Фон прозрачный — источник ляжет поверх сцены.
            </li>
            <li>
              Для звука оповещений отметьте <b>«Управлять звуком через OBS»</b> и проверьте громкость в микшере.
            </li>
          </ol>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Сбросить ссылку оверлея?"
        confirmLabel="Сбросить ссылку"
        danger
        busy={resetting}
        onConfirm={() => void doReset()}
        onCancel={() => {
          setConfirmOpen(false);
          setResetError(null);
        }}
      >
        <p>Старая ссылка сразу перестанет работать: в OBS нужно будет вставить новую.</p>
        {resetError ? (
          <p className="field__error" role="alert">
            <TriangleAlert aria-hidden="true" />
            {resetError}
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
