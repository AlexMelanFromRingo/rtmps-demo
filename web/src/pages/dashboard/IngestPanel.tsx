import { Info, KeyRound, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, errorMessage } from '../../api/client';
import type { IngestInfo } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyField } from '../../components/CopyField';
import { codecLabel } from '../../lib/format';

type TabId = 'rtmp' | 'srt' | 'srtany' | 'whip';

const ALL_TABS: { id: TabId; label: string }[] = [
  { id: 'rtmp', label: 'RTMP' },
  { id: 'srt', label: 'SRT' },
  { id: 'srtany', label: 'SRT · любой кодек' },
  { id: 'whip', label: 'WHIP' },
];

function CodecList({ codecs }: { codecs: string[] }) {
  if (!codecs.length) return null;
  return (
    <div className="ingest__codecs">
      <span className="field__label">Принимаемые кодеки видео</span>
      <ul className="chips">
        {codecs.map((c) => (
          <li key={c} className="chip chip--solid">
            {codecLabel(c)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Steps({ children, title = 'Настройка OBS' }: { children: ReactNode; title?: string }) {
  return (
    <div className="ingest__howto">
      <h3 className="ingest__howto-title">{title}</h3>
      <ol className="steps">{children}</ol>
    </div>
  );
}

const KEYFRAME_STEP = (
  <li>
    В «Настройки» → «Вывод» (расширенный режим) поставьте <b>интервал ключевых кадров 2 с</b> — так
    зрители быстрее подключаются, а качество переключается без рывков.
  </li>
);

export function IngestPanel({
  ingest,
  streamKey,
  onKeyReset,
}: {
  ingest: IngestInfo;
  streamKey: string;
  onKeyReset: () => void;
}) {
  const [tab, setTab] = useState<TabId>('rtmp');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);
  const baseId = useId();
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({ rtmp: null, srt: null, srtany: null, whip: null });
  const TABS = ALL_TABS.filter((t) => t.id !== 'srtany' || ingest.srtAny);

  useEffect(() => {
    if (!resetDone) return;
    const t = window.setTimeout(() => setResetDone(false), 8000);
    return () => window.clearTimeout(t);
  }, [resetDone]);

  const mask = (value: string) => (streamKey ? value.split(streamKey).join('•'.repeat(12)) : value);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = TABS.findIndex((t) => t.id === tab);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  const doReset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      await api.resetStreamKey();
      setConfirmOpen(false);
      setResetDone(true);
      onKeyReset();
    } catch (err) {
      setResetError(errorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="panel ingest" aria-labelledby="ingest-h">
      <div className="panel__head ingest__head">
        <div>
          <h2 className="h-section" id="ingest-h">
            Подключение
          </h2>
          <p className="panel__lede">Адреса и ключ для OBS и других программ.</p>
        </div>
        <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirmOpen(true)}>
          <KeyRound aria-hidden="true" />
          Сбросить ключ
        </button>
      </div>

      {resetDone ? (
        <div className="notice notice--warn ingest__notice" role="status">
          <Info aria-hidden="true" />
          <div className="notice__body">Ключ сброшен. Вставьте новый ключ или адрес в OBS.</div>
        </div>
      ) : null}

      <div className="tabs">
        <div className="tabs__list" role="tablist" aria-label="Протокол">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-controls={`${baseId}-panel-${t.id}`}
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              className="tabs__tab"
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          className="tabs__panel"
          role="tabpanel"
          id={`${baseId}-panel-${tab}`}
          aria-labelledby={`${baseId}-tab-${tab}`}
          tabIndex={0}
        >
          {tab === 'rtmp' ? (
            <div className="ingest__body">
              <CopyField label="Сервер" value={ingest.rtmp.server} />
              <CopyField
                label="Ключ потока"
                value={ingest.rtmp.streamKey}
                secret
                hint="Никому не показывайте ключ: с ним можно вести эфир на вашем канале."
              />
              <CodecList codecs={ingest.rtmp.codecs} />
              <Steps>
                <li>В OBS откройте «Настройки» → «Трансляция».</li>
                <li>
                  Сервис: <b>«Настраиваемый…»</b>. Вставьте «Сервер» и «Ключ потока» отсюда.
                </li>
                {KEYFRAME_STEP}
              </Steps>
              <p className="ingest__note">
                <Info aria-hidden="true" />
                HEVC и AV1 по RTMP работают в OBS 29.1 и новее (Enhanced RTMP). H.264 — в любой версии.
              </p>
            </div>
          ) : tab === 'srt' ? (
            <div className="ingest__body">
              <CopyField
                label="SRT-адрес"
                value={ingest.srt.url}
                secret
                mask={mask}
                hint="Адрес уже содержит ключ трансляции."
              />
              <CodecList codecs={ingest.srt.codecs} />
              <Steps>
                <li>
                  «Настройки» → «Трансляция», сервис: <b>«Настраиваемый…»</b>.
                </li>
                <li>
                  В поле «Сервер» вставьте SRT-адрес целиком, <b>«Ключ потока» оставьте пустым</b>.
                </li>
                {KEYFRAME_STEP}
              </Steps>
              <p className="ingest__note">
                <Info aria-hidden="true" />
                OBS отправляет по SRT только H.264 и HEVC. Для AV1 из OBS используйте RTMP, для AV1/VP9 из
                FFmpeg и других программ — вкладку «SRT · любой кодек».
              </p>
            </div>
          ) : tab === 'srtany' && ingest.srtAny ? (
            <div className="ingest__body">
              <CopyField
                label="SRT-адрес (любой кодек)"
                value={ingest.srtAny.url}
                secret
                mask={mask}
                hint="Адрес уже содержит ключ трансляции."
              />
              <CodecList codecs={ingest.srtAny.codecs} />
              <Steps title="Как отправить">
                <li>
                  Контейнер внутри SRT: <b>{ingest.srtAny.containers.join(', ')}</b>. Для AV1 и VP9 нужен
                  Matroska/WebM или FLV: в MPEG-TS эти кодеки не стандартизированы.
                </li>
                <li>
                  Пример для FFmpeg:{' '}
                  <code className="ingest__code">
                    ffmpeg -re -i video.mkv -c copy -f matroska &quot;{mask(ingest.srtAny.url)}&quot;
                  </code>
                </li>
                <li>Видео и звук передаются без перекодирования, качество для зрителей строит сервер.</li>
              </Steps>
            </div>
          ) : (
            <div className="ingest__body">
              <CopyField
                label="WHIP-адрес"
                value={ingest.whip.url}
                secret
                mask={mask}
                hint="Адрес уже содержит ключ трансляции."
              />
              <CodecList codecs={ingest.whip.codecs} />
              <Steps>
                <li>
                  «Настройки» → «Трансляция», сервис: <b>«WHIP»</b> (есть в OBS 30 и новее).
                </li>
                <li>
                  В поле «Сервер» вставьте WHIP-адрес, «Bearer-токен» оставьте пустым.
                </li>
                {KEYFRAME_STEP}
              </Steps>
              <p className="ingest__note">
                <Info aria-hidden="true" />
                Можно обойтись без OBS: раздел «Эфир из браузера» ниже работает по этому же адресу.
              </p>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Сбросить ключ трансляции?"
        confirmLabel="Сбросить ключ"
        danger
        busy={resetting}
        onConfirm={() => void doReset()}
        onCancel={() => {
          setConfirmOpen(false);
          setResetError(null);
        }}
      >
        <p>
          Старый ключ перестанет работать для новых подключений. Текущий эфир продолжится до разрыва,
          но потом нужно будет вставить новый ключ в OBS.
        </p>
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
