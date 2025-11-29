# Запуск RTMP сервера в Windows через WSL2

## Быстрый старт

### 1. Запуск сервера (в WSL2)

```bash
cd ~/rtmps-demo
npm start
```

Сервер запустится на:
- 📺 **Веб-интерфейс**: http://localhost:3000
- 📡 **RTMP сервер**: rtmp://localhost:1935/live
- 🎬 **Media сервер**: http://localhost:8000

### 2. Доступ из Windows

Благодаря WSL2, все порты автоматически доступны из Windows:
- Откройте браузер в **Windows** и перейдите на http://localhost:3000
- OBS в Windows может подключаться к rtmp://localhost:1935/live

### 3. Настройка OBS (в Windows)

1. Откройте **OBS Studio** в Windows
2. **Настройки → Трансляция**
3. **Служба**: Пользовательский...
4. **Сервер**: `rtmp://localhost:1935/live`
5. **Ключ потока**: `<ваш ключ из веб-интерфейса>`

### 4. Получение ключа трансляции

1. Откройте http://localhost:3000 в браузере Windows
2. Введите название трансляции
3. Нажмите "Создать ключ трансляции"
4. Скопируйте "Ключ потока" и вставьте в OBS

### 5. Начало трансляции

1. В OBS нажмите **"Начать трансляцию"**
2. Откройте страницу просмотра (ссылка будет в веб-интерфейсе)
3. Стрим начнет воспроизводиться через несколько секунд

## Проблемы и решения

### Порты заняты
Если порты заняты, измените их в `server.js`:
```javascript
const WEB_PORT = 3000;  // Измените на другой порт
```

### FFmpeg не найден
FFmpeg уже установлен в WSL2. Проверьте:
```bash
ffmpeg -version
```

### Доступ из локальной сети

Чтобы стримить через локальную сеть:

1. Узнайте IP адрес WSL2:
```bash
hostname -I
```

2. В Windows откройте PowerShell как администратор и добавьте проброс портов:
```powershell
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSL2_IP>
netsh interface portproxy add v4tov4 listenport=1935 listenaddress=0.0.0.0 connectport=1935 connectaddress=<WSL2_IP>
netsh interface portproxy add v4tov4 listenport=8000 listenaddress=0.0.0.0 connectport=8000 connectaddress=<WSL2_IP>
```

3. Откройте порты в брандмауэре Windows

4. Используйте IP адрес вашего компьютера в локальной сети

### Остановка сервера

Нажмите `Ctrl+C` в терминале WSL2

## Автозапуск (опционально)

Создайте скрипт для автозапуска в WSL2:

```bash
# Создайте файл start-rtmp.sh
cat > start-rtmp.sh << 'EOF'
#!/bin/bash
cd ~/rtmps-demo
npm start
EOF

chmod +x start-rtmp.sh

# Запуск
./start-rtmp.sh
```

## Полезные команды

```bash
# Проверить запущен ли сервер
curl http://localhost:3000/api/keys

# Создать ключ через API
curl -X POST http://localhost:3000/api/generate-key \
  -H "Content-Type: application/json" \
  -d '{"name":"My Stream"}'

# Просмотреть логи сервера
# (они отображаются в терминале где запущен npm start)
```

## Архитектура

```
Windows (OBS) → RTMP (port 1935) → WSL2 (Node.js + FFmpeg) → HLS (port 8000)
                                                ↓
Windows (Browser) ← HTTP (port 3000) ← Express Server
```

OBS в Windows отправляет RTMP поток в WSL2, где FFmpeg конвертирует его в HLS, который воспроизводится в браузере через Video.js.
