# GDZ Steam FFmpeg Converter — Railway v1.0.0

Небольшой защищённый HTTP-сервис для преобразования Steam HLS (`.m3u8`) в MP4, совместимый с Telegram `sendVideo`.

## API

### `GET /health`

Возвращает `200` без авторизации.

### `POST /convert`

Заголовки:

```text
Authorization: Bearer <CONVERTER_API_TOKEN>
Content-Type: application/json
```

Тело:

```json
{
  "hls_url": "https://video.akamai.steamstatic.com/.../hls_264_master.m3u8?..."
}
```

Успешный ответ: бинарный `video/mp4`.

## Переменные Railway

Обязательная:

- `CONVERTER_API_TOKEN` — длинная случайная строка, минимум 32 символа.

Необязательные:

- `MAX_OUTPUT_MB=48`
- `FFMPEG_TIMEOUT_SECONDS=240`

`PORT` Railway добавляет автоматически.

## Настройка Railway

1. Создать новый Railway Project.
2. Добавить сервис из GitHub-репозитория с этими файлами или загрузить папку через Railway CLI (`railway up`).
3. В Variables добавить `CONVERTER_API_TOKEN`.
4. В Settings → Networking → Public Networking нажать `Generate Domain`.
5. Проверить `https://<домен>/health`.
6. Serverless/App Sleeping пока не включать до завершения первого runtime-теста.

## Первый безопасный тест

Сначала вызвать `/health`, затем `/convert` из отдельного неактивного n8n workflow. Production `GDZ_09`, Supabase и публикации не изменять до получения MP4 в Telegram.

## Ограничения и защита

- Разрешены только HTTPS URL с утверждённых Steam CDN hosts.
- Одновременно выполняется одна конвертация; следующая получает HTTP `429`.
- Входной JSON ограничен 16 KiB.
- FFmpeg timeout по умолчанию 240 секунд.
- Итоговый файл ограничен 48 MiB.
- Каждый запрос использует отдельную временную директорию, которая удаляется после ответа.
- Токен не записывается в логи.
- Видео перекодируется в H.264/AAC, максимум 854 px по ширине, `yuv420p`, `faststart`.

