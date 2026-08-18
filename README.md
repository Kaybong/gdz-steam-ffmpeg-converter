# GDZ Steam FFmpeg Converter — Railway v1.0.2

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
- Видео перекодируется в H.264 High Profile/AAC, 1280 px по ширине, `CRF 20`, `yuv420p`, `faststart`.
- Размер кадра всегда приводится к чётной ширине и высоте, как требует `libx264/yuv420p`.

## Изменения v1.0.1

- Исправлена runtime-ошибка FFmpeg `width not divisible by 2`.
- Удалён `force_original_aspect_ratio=decrease`, который мог вернуть нечётную ширину.
- Масштабирование выполняется через `scale=854:-2`: ширина фиксированно чётная, высота рассчитывается FFmpeg кратной двум.

## Изменения v1.0.2

- Повышено целевое разрешение с 854 px до 1280 px по ширине; типичный Steam-трейлер 16:9 получается `1280×720`.
- Пропорции источника сохраняются: без квадратного кадрирования, обрезки и растягивания.
- Качество видео повышено до `CRF 20`, preset `fast`, H.264 High Profile Level 4.0.
- Качество звука повышено со 128 до 160 кбит/с AAC.
