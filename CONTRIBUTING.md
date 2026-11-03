# Как участвовать в разработке

Спасибо за интерес к StreamHub! Здесь описано, как поднять окружение, прогнать тесты и
оформить изменения. Участвуя, вы соглашаетесь с [кодексом поведения](CODE_OF_CONDUCT.md).
Об уязвимостях сообщайте по [SECURITY.md](SECURITY.md), а не в публичных issues.

## Окружение

Нужны:
- **Docker** с Compose v2 — весь стек и e2e-тесты работают в контейнерах;
- **Node.js 24** (`engines: >=24`) — сервер запускает TypeScript напрямую, без сборки;
- **Go** версии из `deploy/srt-gateway/go.mod` (сейчас 1.26) — только для работы над srt-gateway.

Локально FFmpeg не нужен: тестовые публикаторы запускаются из образа `mwader/static-ffmpeg`.

```bash
docker compose up -d --build          # весь стек → http://localhost:8080
cd server && npm ci                   # зависимости для typecheck и тестов
cd ../web && npm ci && npm run dev    # фронтенд с hot reload (Vite), /api и /hls → :8080
```

Другой адрес бэкенда для Vite задаётся через `STREAMHUB_BACKEND=http://host:port`. После правок
в `server/` пересоберите сервисы: `docker compose up -d --build api worker`.

Тестовый эфир без OBS:

```bash
scripts/demo-stream.sh <ключ> [h264|hevc|av1|vp9] [rtmp|srt|srtany|whip] [ШxВ] [fps]
```

Метрики и дашборды:
`docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d`
(см. [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)).

## Структура

| Каталог | Что внутри |
|---|---|
| `server/src/api` | Fastify: маршруты, сессии, SSE |
| `server/src/control` | жизненный цикл эфиров, сверка с ingest, лидер |
| `server/src/worker` | очередь заданий, лестница, ffmpeg, выгрузка в S3 |
| `server/src/lib` | общие модули (БД, Valkey, S3, крипто, логи) |
| `server/migrations` | SQL-миграции |
| `web/` | SPA: Vite + React 19 + hls.js |
| `deploy/` | ingest (MediaMTX), srt-gateway (Go), edge (nginx), observability |
| `docs/` | архитектура, API, эксплуатация, наблюдаемость |

## Тесты

| Что | Команда | Когда |
|---|---|---|
| типы сервера | `cd server && npm run typecheck` | всегда |
| unit-тесты сервера | `cd server && npm test` | всегда |
| сборка web (вместе с typecheck) | `cd web && npm run build` | при правках `web/` |
| srt-gateway | `cd deploy/srt-gateway && gofmt -l . && go vet ./... && go test ./...` | при правках шлюза |
| e2e | `cd server && npm run test:e2e` (нужен запущенный `docker compose up`) | при правках пайплайна, ingest, API |
| конфиги наблюдаемости | см. job `observability` в `.github/workflows/ci.yml` | при правках `deploy/observability/` |

- Unit-тесты используют встроенный `node:test` и лежат в `server/test/unit/*.test.ts`.
  Чистую логику (лестница, аргументы ffmpeg, кодеки, плейлисты) выносите в функции без I/O
  и покрывайте тестами.
- e2e (`server/test/e2e/`) публикуют настоящие потоки RTMP/SRT/WHIP в разных кодеках.
  Им нужны свободные порты стека и доступ к `docker`. Адреса задаются через `E2E_BASE_URL`,
  `E2E_HLS_ORIGIN`, `E2E_INGEST_HOST`, `E2E_COMPOSE_PROJECT`.
- CI (`.github/workflows/ci.yml`) прогоняет typecheck, unit-тесты, сборку web, проверки
  srt-gateway, конфигов наблюдаемости и сборку всех образов. e2e (`e2e.yml`) запускается
  вручную и при пуше в ветку по умолчанию.

## Стиль кода

Общие правила задаёт [`.editorconfig`](.editorconfig): UTF-8, LF, 2 пробела (Go — табы).
Отдельного линтера или форматтера для TypeScript нет: следуйте стилю окружающего кода
(одинарные кавычки, точки с запятой, `const` по умолчанию).

**TypeScript (server).** Node 24 исполняет `.ts` напрямую (type stripping), поэтому:
- в импортах пишите расширение `.ts` (`import { x } from './x.ts'`);
- типы импортируйте через `import type` (`verbatimModuleSyntax`);
- только стираемый синтаксис (`erasableSyntaxOnly`): без `enum`, `namespace` и parameter properties;
- код должен проходить `strict` и `noUncheckedIndexedAccess`.

**Ввод и ошибки.** Входные данные API проверяйте схемами `zod`. Ошибки для клиента бросайте
как `HttpError(status, code, message)` с машинным `code`. Новые коды добавляйте в `docs/API.md`.

**Язык.** Тексты для пользователя (UI, сообщения об ошибках API) — на русском. Идентификаторы,
комментарии в коде и логи — на английском.

**Логи.** Только структурированный pino-лог. Секреты и ключи трансляции в логи и в БД не пишутся:
ошибки, в которых может оказаться URL с ключом, пропускайте через `redact()`.

**Метрики.** Новые метрики называйте с префиксом `streamhub_<компонент>_`, метки делайте
с ограниченным набором значений (шаблон маршрута, а не URL; никаких ключей, логинов, IP).
Обновите дашборд и `docs/OBSERVABILITY.md`.

**Миграции.** Новый файл `server/migrations/NNNN_описание.sql` со следующим номером.
Уже применённые миграции не редактируйте. Изменения схемы должны быть совместимы
с предыдущей версией кода: API и воркеры обновляются по одной реплике.

**Go (srt-gateway).** `gofmt` и `go vet` обязательны (проверяются в CI).

## Коммиты: Conventional Commits

Сообщения коммитов пишем на английском по [Conventional Commits 1.0](https://www.conventionalcommits.org/ru/v1.0.0/):

```
<тип>(<область>): <что сделано, в повелительном наклонении>

<зачем и как — по желанию>

BREAKING CHANGE: <что ломается и как мигрировать — если есть>
```

- **Типы:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `revert`.
- **Области:** `api`, `control`, `worker`, `web`, `ingest`, `srt-gateway`, `edge`, `deploy`,
  `observability`, `deps`.
- Несовместимое изменение помечается `!` после типа/области (`feat(api)!: …`) или футером
  `BREAKING CHANGE:`.

Примеры:

```
feat(worker): add AV1 rung to the ladder when a GPU encoder is available
fix(control): keep the broadcast live while any node still reports the source
docs(observability): describe the S3 latency alert
```

## Pull request

1. Ответвитесь от ветки по умолчанию. Один PR — одна логическая задача.
2. Прогоните тесты из таблицы выше. Для изменений пайплайна или ingest — и e2e.
3. Обновите документацию: `README.md`, `docs/API.md` (контракт API), `docs/OPERATIONS.md` (новые
   переменные окружения, порты), `.env.example`.
4. Добавьте запись в раздел `[Unreleased]` файла [CHANGELOG.md](CHANGELOG.md).
5. В описании PR объясните, что и зачем изменено и как вы это проверили.

Вклад принимается под [лицензией MIT](LICENSE) проекта.
