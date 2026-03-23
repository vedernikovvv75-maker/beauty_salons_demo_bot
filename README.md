# Beauty salons — Telegram demo bot (Python)

Демо-бот для салонов: сценарии отзывов, модерация скринов в группе, ROI, пакеты, рассылка `/send_promo` с **актуальным парсингом** 2ГИС/Яндекс через Node (Playwright).

## Требования

- Python 3.10+
- Node.js 18+ (для `node_scripts/` — те же метрики, что в проекте парсинга)

## Установка

```bash
cd D:\vibe-coding\beauty-salons
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

cd node_scripts
npm install
npx playwright install chromium
```

Скопируйте `EnvExample` → `.env`, задайте `BOT_TOKEN` и при необходимости `ADMIN_IDS`, `ADMIN_GROUP_CHAT_ID`.
Если в вашей сети Telegram API недоступен напрямую, добавьте `HTTPS_PROXY=http://user:pass@host:port`.

Для рассылки скопируйте `leads.example.json` → `leads.json` и укажите реальные `telegram_chat_id` (клиент должен нажать **Start** у бота).

## Запуск бота

Из корня проекта:

```bash
python -m bot
```

или `python -m bot.main`.

## Команды

- `/start` — приветствие и кнопка «Запустить демо»
- `/help`
- `/send_promo` — только админы; перед отправкой вызывается парсинг метрик (Node)

Опция `/send_promo --all` — повторная рассылка даже для `sent: true` (если реализовано в тексте команды: добавьте `--all` в сообщение).

## Структура

- `bot/main.py` — aiogram, сценарии
- `bot/promo_copy.py` — тексты рассылки (HTML)
- `bot/salon_metrics.py` — вызов `node_scripts/fetch_metrics.cjs`
- `node_scripts/salon_metrics.cjs` — Playwright (копия логики из репозитория парсинга)

Парсинг карт **не дублирован на Python**: используется проверенный Node-модуль.

## Docker

### Локальный запуск через Docker Compose

1. Подготовьте `.env` (скопируйте `EnvExample`), `leads.json`, `applications.json`.
2. Запустите:

```bash
cd D:\vibe-coding\beauty-salons
docker compose up -d --build
```

Логи:

```bash
docker compose logs -f bot
```

Остановка:

```bash
docker compose down
```

### Сборка и push в Docker Registry

Пример для Docker Hub (замените `your_dockerhub_login`):

```bash
cd D:\vibe-coding\beauty-salons
docker build -t your_dockerhub_login/beauty-salons-bot:latest .
docker login
docker push your_dockerhub_login/beauty-salons-bot:latest
```

Запуск из готового образа:

```bash
docker run -d --name beauty-salons-bot --restart unless-stopped ^
  --env-file .env ^
  -v %cd%\\leads.json:/app/leads.json ^
  -v %cd%\\applications.json:/app/applications.json ^
  your_dockerhub_login/beauty-salons-bot:latest
```
