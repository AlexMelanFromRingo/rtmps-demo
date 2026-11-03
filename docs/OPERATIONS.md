# Эксплуатация и продакшен

## Чек-лист перед публичным запуском

1. **Секреты.** Скопируйте `.env.example` → `.env` и задайте `INTERNAL_SECRET`,
   `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (`openssl rand -hex 32`,
   только URL-безопасные символы). С секретом по умолчанию и не-localhost URL API не стартует.
2. **Публичные URL.** `PUBLIC_RTMP_URL`, `PUBLIC_SRT_URL`, `PUBLIC_WHIP_URL` — адреса,
   доступные с машин стримеров. `WEBRTC_PUBLIC_HOSTS` — публичный IP/хост ingest-узла
   (иначе WHIP-кандидаты будут внутренними адресами Docker).
3. **TLS.** Поставьте TLS-терминатор перед edge (Caddy, Traefik, облачный LB) и задайте
   `COOKIE_SECURE=true`. Для WHIP из браузера с другого хоста нужен HTTPS (камера/экран
   доступны только в secure context), то есть TLS и для порта 8889.
   RTMPS: `MTX_RTMPENCRYPTION=optional` + сертификаты (`MTX_RTMPSERVERKEY/CERT`), порт 1936.
4. **Сеть.** Наружу открыты только edge (80/443), RTMP 1935/tcp, SRT 8890/udp,
   универсальный SRT 8891/udp, WHIP 8889/tcp, WebRTC 8189/udp+tcp. `SRT_PASSPHRASE` включает
   шифрование на универсальном SRT-входе. Порты 8554 (RTSP), 9997/9998 (API/метрики
   MediaMTX), 3000, 9100, Postgres, Valkey, SeaweedFS — только во внутренней сети.
5. **Ёмкость.** `WORKER_REPLICAS × WORKER_SLOTS` ≥ пиковое число эфиров с полной лестницей
   + запас на падение одного воркера (N+1). Остальные эфиры уйдут в degraded-режим.

## Масштабирование по компонентам

| Что растёт | Действие |
|---|---|
| Число зрителей | Больше edge-реплик и/или CDN: `PUBLIC_HLS_BASE=https://cdn.example.com/hls`, origin — edge или S3 |
| Число эфиров | `WORKER_REPLICAS`, `WORKER_SLOTS`; GPU-хосты с `ENCODER=h264_nvenc` |
| Число стримеров / гео | Дополнительные ingest-узлы под L4 LB (RTMP/TCP, SRT/UDP) или GeoDNS; узлы регистрируются сами |
| API / SSE | `API_REPLICAS`; SSE масштабируется через Valkey pub/sub |
| Хранилище | Кластер SeaweedFS (master×3, volume×N, filer×N) или облачный S3/R2 |
| БД | Managed Postgres / Patroni + реплики; пул соединений `DATABASE_POOL_MAX` (PgBouncer при сотнях реплик) |

Пример локального масштабирования:

```bash
API_REPLICAS=3 WORKER_REPLICAS=4 docker compose up -d
```

### Несколько ingest-узлов

Каждый узел — отдельный хост с образом `streamhub/ingest`:

```bash
docker run -d --name ingest --network host \
  -e CONTROL_URL=https://api.internal:3000 -e INTERNAL_SECRET=… \
  -e NODE_ID=ingest-fra-1 \
  -e NODE_API_URL=http://10.0.1.11:9997 -e NODE_RTSP_URL=rtsp://10.0.1.11:8554 -e NODE_SRT_URL=srt://10.0.1.11:8890 \
  -e MTX_WEBRTCADDITIONALHOSTS=203.0.113.11 \
  streamhub/ingest:latest
```

Узел появится в `ingest_nodes` после первого heartbeat. Control loop начнёт его сверять,
а воркеры будут тянуть потоки с него по внутренним URL.

### Высокая доступность хранилищ

- **PostgreSQL** — единственный критичный stateful-компонент: managed-сервис или Patroni
  (3 узла) + бэкапы (pgBackRest/WAL-G). Advisory lock лидера переживает failover БД:
  после переключения лидер выбирается заново.
- **Valkey** — Sentinel (3 узла) или managed. Данные эфемерные: при полной потере
  теряются только текущие счётчики зрителей.
- **SeaweedFS** — `replication=001`+ на volume-серверах; или облачное хранилище.

## Записи, мультистрим, секреты

- **Записи (VOD)** занимают место: сумма битрейтов лестницы × длительность (1080p60-эфир ≈ 8 ГБ/ч).
  Срок хранения — `VOD_RETENTION_DAYS`; стример может отключить запись в Студии.
- **Мультистрим** — исходящий трафик: битрейт источника × число направлений на каждый эфир.
  Направления с перекодированием в H.264 (HEVC/AV1 → Twitch/Kick) занимают CPU воркера.
  Внутренние адреса запрещены (`RESTREAM_ALLOW_PRIVATE=false`).
- **Секреты в БД** (TOTP, ключи направлений) зашифрованы ключом из `DATA_ENCRYPTION_KEY`
  (по умолчанию выводится из `INTERNAL_SECRET`). При смене ключа сохранённые секреты станут
  нечитаемыми: пользователям придётся заново включить 2FA и ввести ключи направлений.

## Мониторинг

Готовый стек Prometheus + Grafana с дашбордом и алертами: [OBSERVABILITY.md](OBSERVABILITY.md).

Метрики Prometheus (только внутренняя сеть):

| Источник | Endpoint | Ключевые метрики |
|---|---|---|
| API | `api:3000/metrics` | `streamhub_api_request_seconds`, `streamhub_api_sse_clients`, `streamhub_ingest_auth_total` |
| Воркер | `worker:9100/metrics` | `streamhub_worker_active_jobs`, `streamhub_worker_slots`, `streamhub_worker_ffmpeg_exits_total{reason}`, `streamhub_worker_upload_seconds` |
| MediaMTX | `ingest:9998/metrics` | входящие байты, сессии |
| nginx | логи `X-Cache-Status` | доля HIT по HLS |

Рекомендуемые алерты:
- `sum(active_jobs) / sum(slots) > 0.8` в течение 5 мин — не хватает воркеров;
- рост `ffmpeg_exits_total{reason="exit"}` — источники/кодеки, которые падают;
- `histogram_quantile(0.99, upload_seconds) > 1` — медленное хранилище;
- задания в `failed` (SQL ниже).

Логи — структурированный JSON (pino) в stdout.

## Полезные запросы

```sql
-- Живые эфиры и их транскод
SELECT c.slug, b.status, b.protocol, b.video_codec, b.width, b.height, b.ingest_kbps,
       j.state, j.worker_id, j.attempts, j.stats->>'speed' AS speed, j.stats->>'degraded' AS degraded
  FROM broadcasts b JOIN channels c ON c.id = b.channel_id
  LEFT JOIN transcode_jobs j ON j.broadcast_id = b.id AND j.state IN ('pending','running')
 WHERE b.status <> 'ended';

-- Проблемные задания
SELECT id, broadcast_id, state, attempts, last_error FROM transcode_jobs
 WHERE state = 'failed' OR attempts > 3 ORDER BY updated_at DESC LIMIT 20;

-- Ingest-узлы
SELECT id, api_url, now() - last_seen_at AS silent_for FROM ingest_nodes;
```

## Runbook

| Симптом | Проверить | Действие |
|---|---|---|
| Стример «в эфире» в OBS, на сайте оффлайн | логи ingest: `auth denied`/`runOnOnline`; `ingest_nodes` | ключ сброшен? узел не шлёт heartbeat (сеть до API)? |
| Эфир есть, плеер крутит спиннер | задание: `state`, `last_error`, `attempts` | кодек/ffmpeg, свободные слоты; `degraded=true` — добавить воркеров |
| Картинка подвисает раз в ~минуту | `speed` < 1.0 у задания | воркер перегружен: меньше `WORKER_SLOTS`, быстрее `X264_PRESET`, GPU |
| 404 на сегменты | `upload_seconds`, логи `object storage is falling behind` | хранилище/сеть до S3 |
| Нет счётчиков зрителей | `/readyz` → `redis:false` | Valkey |

## Обновления без простоя

- **Воркеры:** `docker compose up -d worker` — SIGTERM, задания сразу возвращаются в
  очередь и подхватываются другими (пауза у зрителей ~3–5 с). `stop_grace_period: 30s`.
- **API:** реплики обновляются по одной; edge повторяет запрос на живой реплике.
- **Миграции:** вперёд-совместимые, применяются one-shot сервисом `migrate` под advisory lock.
- **Ingest:** перезапуск обрывает соединения стримеров этого узла. OBS переподключится
  (в пределах 30 с это тот же эфир). Для бесшовности выводите узел из LB заранее.
