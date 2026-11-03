# StreamHub — открытый мини-Twitch

Платформа живых трансляций с открытым кодом. Много стримеров одновременно, приём в
**H.264, H.265/HEVC, AV1, VP9, VP8** по **RTMP / Enhanced RTMP, SRT и WebRTC (WHIP)**,
адаптивная раздача зрителям (HLS/CMAF) с исходным качеством и H.264-лестницей.
Есть горизонтальное масштабирование и отказоустойчивость. Чата пока нет.

- Аккаунты и каналы: регистрация, у каждого пользователя канал `/<логин>` и свой ключ трансляции.
- Каталог живых эфиров: превью обновляются каждые 10 с, видны зрители, кодек и разрешение.
- Страница канала: плеер с выбором качества и кодека, live-статус через SSE, счётчик зрителей, аптайм.
- Студия стримера: адреса для OBS (RTMP/SRT/WHIP), сброс ключа, название/категория,
  статистика эфира в реальном времени, история эфиров.
- **Эфир прямо из браузера** (камера или экран, WHIP) с выбором кодека AV1/VP9/VP8/H.264.
- **Исходник без перекодирования** для H.264/HEVC/AV1 + H.264-лестница 1080/720/480/360/160
  ниже разрешения источника (без апскейла).
- **Отказоустойчивость:** падение воркера → эфир продолжается на другом за ~15 с;
  переподключение стримера в течение 30 с — тот же эфир; потерянные события чинит сверка.
- **Мягкая деградация:** если мощностей не хватает, эфир стартует в режиме «только исходник».

### Функции уровня Twitch / YouTube / Streamlabs

| Функция | Аналог | Как устроено |
|---|---|---|
| Подписки на каналы, «Отслеживаемые» | Twitch Follow, YouTube Subscribe | счётчик подписчиков, живые каналы из подписок первыми |
| Записи эфиров (VOD) с перемоткой | Twitch Past Broadcasts, YouTube Live replay | каждый эфир пишется во всех качествах без доп. перекодирования; переживает failover; хранится `VOD_RETENTION_DAYS` |
| Мультистрим на Twitch / YouTube / Kick / свой RTMP(S)/SRT | Streamlabs Multistream, Restream | серверная ретрансляция, видео копируется, если платформа принимает кодек; статус по каждому направлению |
| Оповещения о подписчиках и счётчик зрителей в OBS | Streamlabs Alerts / виджеты | секретная ссылка для OBS «Браузер», тестовое оповещение |
| Режим низкой задержки | Twitch Low Latency, YouTube «низкая задержка» | сегменты 1 с, ≈ 3–4 с вместо 6–10 с |
| Каталог категорий и поиск | Twitch Browse | живые категории по зрителям, поиск по каналам и названиям (pg_trgm) |
| Профиль канала: аватар, описание, ссылки, 18+ | Twitch «О канале», Mature Content | аватар проверяется по сигнатуре файла, 18+ — экран подтверждения |
| Здоровье эфира | Twitch Stream Manager, OBS Stats | графики входного битрейта и зрителей, скорость транскода |
| 2FA (TOTP) + резервные коды | Twitch/YouTube 2-Step | RFC 6238, защита от повтора кода, секреты зашифрованы AES-256-GCM |
| Управление сессиями, смена пароля | «Устройства» в аккаунте | выход на других устройствах, при смене пароля — автоматически |
| AV1 / HEVC без перекодирования | Twitch Enhanced Broadcasting (AV1), YouTube HEVC/AV1 ingest | Enhanced RTMP, WHIP, универсальный SRT |
| Несколько качеств от OBS одним соединением | Twitch Enhanced Broadcasting | дорожки OBS идут зрителям как есть, сервер кодирует только недостающие |

## Быстрый старт

Нужен Docker с Compose v2.

```bash
docker compose up -d --build
```

Откройте **http://localhost:8080**, зарегистрируйтесь и перейдите в «Студию».

Сервисы: `edge` (сайт, :8080), `api` ×2, `worker` ×2, `ingest` (RTMP :1935, SRT :8890/udp,
WHIP :8889, WebRTC :8189), `srt-gateway` (универсальный SRT :8891/udp), `postgres`, `valkey`, `seaweedfs`.

## Как стримить

| Протокол | Кодеки видео | Настройка OBS |
|---|---|---|
| **RTMP** (Enhanced RTMP) | H.264, H.265, AV1, VP9 | Настройки → Трансляция → «Настраиваемый»: сервер `rtmp://<хост>:1935/live`, ключ из Студии. HEVC/AV1 — OBS ≥ 29.1 |
| **SRT** | H.264, H.265 | Сервер: полный URL из Студии `srt://<хост>:8890?streamid=publish:live/<ключ>&pkt_size=1316`, ключ пустой |
| **SRT · любой кодек** | AV1, VP9, VP8, H.265, H.264 | `srt://<хост>:8891?streamid=publish:live/<ключ>`; контейнер Matroska/WebM, FLV или MPEG-TS (FFmpeg, GStreamer, железо) |
| **WHIP** (WebRTC) | H.264, H.265, AV1, VP9, VP8 | Служба «WHIP», сервер `http://<хост>:8889/live/<ключ>/whip` (OBS ≥ 30) |
| **Браузер** | AV1, VP9, VP8, H.264 (что поддерживает браузер) | Студия → «Эфир из браузера» |

**AV1 и SRT.** OBS (вплоть до 33.x) отправляет по SRT только H.264/HEVC, поэтому AV1 из OBS идёт
по RTMP (Enhanced RTMP) или WHIP. AV1/VP9 внутри MPEG-TS не стандартизированы: FFmpeg не может их
прочитать. Для них есть универсальный SRT-вход (порт 8891), который принимает Matroska/WebM/FLV и
передаёт поток дальше без перекодирования. Если кодек по выбранному протоколу прочитать нельзя,
Студия показывает понятную ошибку, а не «эфир без видео».

**Несколько качеств из OBS (Enhanced Broadcasting / Multitrack Video).** OBS ≥ 31 умеет сам
кодировать несколько разрешений и отправлять их одним RTMP-соединением (так работает Twitch
Enhanced Broadcasting). StreamHub отдаёт такие дорожки зрителям без перекодирования и кодирует
только недостающие ступени. В OBS: «Настройки» → «Трансляция» → сервис «Настраиваемый…»,
включите **«Включить многодорожечное видео»** и при необходимости «Переопределение конфигурации»
(JSON со списком `encoder_configurations`, пример — в
[документации MediaMTX](https://github.com/bluenviron/mediamtx/blob/main/docs/3-publish/10-obs-studio.md)).

Рекомендации: интервал ключевых кадров 2 с, CBR. Чем ниже задержка источника, тем меньше
итоговая (сейчас ≈ 6–10 с).

Без OBS можно запустить тестовый эфир (FFmpeg 9 в Docker):

```bash
scripts/demo-stream.sh <ключ> av1 rtmp 1920x1080 60    # кодек: h264|hevc|av1|vp9, протокол: rtmp|srt|whip
```

FFmpeg-примеры:

```bash
# RTMP, AV1 (Enhanced RTMP)
ffmpeg -re -i in.mp4 -c:v libsvtav1 -preset 10 -g 60 -c:a aac -f flv rtmp://localhost:1935/live/<ключ>
# SRT, HEVC
ffmpeg -re -i in.mp4 -c:v libx265 -g 60 -c:a aac -f mpegts "srt://localhost:8890?streamid=publish:live/<ключ>&pkt_size=1316"
# SRT (универсальный вход), AV1 + Opus в Matroska
ffmpeg -re -i in.mp4 -c:v libsvtav1 -preset 10 -g 60 -c:a libopus -f matroska "srt://localhost:8891?streamid=publish:live/<ключ>"
```

## Что получает зритель

Для источника HEVC 1080p60, например:

| Вариант | Кодек | Кто воспроизводит |
|---|---|---|
| `source` | HEVC, без перекодирования | Safari, Chrome/Edge с аппаратным HEVC |
| `1080p60`, `720p60`, `480p`, `360p`, `160p` | H.264 | все браузеры |

Плеер (hls.js) сам скрывает варианты, которые браузер не умеет декодировать, и адаптирует
качество к сети. Старт идёт с совместимого H.264 ≈720p.

## Архитектура

```
OBS/браузер ─RTMP/SRT/WHIP─▶ ingest (MediaMTX) ──RTSP/SRT──▶ worker × N (FFmpeg 9: ABR)
                                │ auth, хуки, heartbeat              │ fMP4 HLS (PUT)
                                ▼                                    ▼
зрители ◀── edge (nginx: SPA, LB, HLS-кэш) ◀── api × N ◀──▶ PostgreSQL     SeaweedFS (S3)
                                                 └──────▶ Valkey (зрители, pub/sub, rate limit)
```

Подробно: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — решения, модель данных, сценарии
отказов. API: [docs/API.md](docs/API.md). Продакшен и масштабирование:
[docs/OPERATIONS.md](docs/OPERATIONS.md). Мониторинг: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

## Конфигурация

Всё настраивается через `.env` (см. [.env.example](.env.example)). Главное:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `INTERNAL_SECRET` | dev-значение | секрет между ingest/воркерами и API — **обязателен** вне localhost |
| `PUBLIC_RTMP_URL` / `PUBLIC_SRT_URL` / `PUBLIC_WHIP_URL` | localhost | адреса, которые видят стримеры |
| `PUBLIC_HLS_BASE` | `/hls` | база плейлистов (можно CDN) |
| `WEBRTC_PUBLIC_HOSTS` | — | публичный IP ingest для WebRTC |
| `API_REPLICAS` / `WORKER_REPLICAS` | 2 / 2 | число реплик |
| `WORKER_SLOTS` | 2 | одновременных полных транскодов на воркер |
| `ENCODER` | `auto` | `libx264` / `h264_nvenc` / `h264_qsv` (auto проверяет железо) |
| `LADDER` | `1080,720,480,360,160` | ступени H.264-лестницы |
| `VOD_RETENTION_DAYS` | 7 | сколько хранятся записи эфиров |
| `RESTREAM_ALLOW_PRIVATE` | `false` | разрешить мультистрим во внутреннюю сеть (только для тестов) |
| `RESTART_POLICY` | `no` | `unless-stopped` — автозапуск и перезапуск контейнеров на сервере |
| `DATA_ENCRYPTION_KEY` | из `INTERNAL_SECRET` | ключ шифрования секретов 2FA и ключей мультистрима |

## Разработка

```
server/   Node 24 + TypeScript (запускается без сборки): API, control plane, воркер
  src/api        Fastify: маршруты, сессии, SSE
  src/control    жизненный цикл эфиров, сверка с ingest, лидер
  src/worker     очередь заданий, ladder/ffmpeg/master-плейлист, выгрузка в S3
  migrations/    SQL-миграции
web/      Vite + React 19 + hls.js (SPA)
deploy/   ingest (MediaMTX + хуки), srt-gateway (Go: SRT любого кодека), edge (nginx)
docs/     архитектура, API, эксплуатация
```

```bash
cd server && npm ci
npm run typecheck
npm test                  # unit-тесты (ladder, codecs, ffmpeg-аргументы, порядок выгрузки…)
npm run test:e2e          # e2e против запущенного `docker compose up` (нужен docker);
                          # для проверки мультистрима: RESTREAM_ALLOW_PRIVATE=true docker compose up -d
cd ../deploy/srt-gateway && go test ./...   # шлюз SRT

cd web && npm ci && npm run dev   # фронтенд с hot reload, проксирует /api и /hls на :8080
```

e2e-набор публикует реальные потоки FFmpeg 9 одновременно в разные каналы: RTMP H.264/HEVC/AV1,
SRT HEVC 1080p, SRT-шлюз AV1+Opus в Matroska, WHIP H.264+Opus. Он проверяет:
- master-плейлисты с правильными `CODECS`;
- сегменты, init-файлы и превью;
- каталог, SSE и счётчик зрителей;
- отказ в публикации по неверному или сброшенному ключу;
- защиту от CSRF;
- закрытость служебных эндпоинтов;
- переход в `reconnecting`;
- перехват транскода другим воркером после `SIGKILL`.

## Лицензия

MIT
