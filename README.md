# Beauty salons — Telegram demo bot (Python)

Демо-бот для салонов: сценарии отзывов, модерация скринов в группе, ROI, пакеты, рассылка `/send_promo` с **актуальным парсингом** 2ГИС/Яндекс через Node (Playwright).

## О проекте (для портфолио)

**Название:** Beauty salons — Telegram demo bot (`beauty_salons_demo_bot`)

**Цель:** Показать бизнесу (владельцам салонов/студий красоты) демо-бот, который автоматизирует сбор заявок, демонстрацию оффера и оценку окупаемости рекламы.

**Задачи проекта:**

- Автоматизировать сценарий получения заявки из Telegram.
- Показать владельцу салона метрики (ROI, заявки, конверсия) в привычном формате.
- Продемонстрировать связку Python (aiogram) + Node.js (Playwright) + Docker на реальном бизнес-кейсе.

**Результат:**

- Готовый демо-бот, которого можно быстро развернуть на сервере или через Docker.
- Админ-сценарии: алерты о новых заявках, модерация скринов в группе, рассылка `/send_promo`.
- Подключенный парсинг 2ГИС/Яндекс для актуальных метрик перед рассылкой.

**Использованные технологии:**

- Python 3.10+, aiogram.
- Node.js 18+, Playwright.
- Docker, Docker Compose.
- JSON-хранилище для лидов и заявок.

Код оформлен по PEP 8; локально можно прогонять **[ruff](https://docs.astral.sh/ruff/)** и **[black](https://black.readthedocs.io/)**, базовые тесты — **pytest** (см. раздел «Тесты»).

## Для кого этот бот

- Владельцы салонов красоты, студий, мастера.
- Маркетологи, которые запускают рекламу и хотят отследить заявки и окупаемость из Telegram.

## Ключевые возможности

- Сценарий демо для салона: пользователь получает оффер, оставляет заявку.
- Автоуведомления администратору о новых заявках в личку или групповой чат.
- Модерация скриншотов в админ-чате перед публикацией.
- Рассылка `/send_promo` с автообновлением метрик салона через 2ГИС/Яндекс (Node.js + Playwright).
- Поддержка Docker: быстрый деплой бота как единого сервиса.
- Хранение лидов и заявок в JSON, возможность быстро подключить CRM.

## Требования

- Python 3.10+
- Node.js 18+ (для `node_scripts/` — те же метрики, что в проекте парсинга)

## Установка

1. Клонировать репозиторий:

   ```bash
   git clone https://github.com/sleahy115/beauty_salons_demo_bot.git
   cd beauty_salons_demo_bot
   ```

2. Создать и активировать виртуальное окружение:

   ```bash
   python -m venv .venv
   source .venv/bin/activate   # macOS / Linux
   # .venv\Scripts\activate   # Windows
   ```

3. Установить зависимости Python:

   ```bash
   pip install -r requirements.txt
   ```

4. Установить зависимости Node.js и Chromium для Playwright:

   ```bash
   cd node_scripts
   npm install
   npx playwright install chromium
   cd ..
   ```

5. Скопируйте `EnvExample` → `.env`, задайте `BOT_TOKEN` и при необходимости `ADMIN_IDS`, `ADMIN_GROUP_CHAT_ID`.  
   Если Telegram API недоступен напрямую из вашей сети: `HTTPS_PROXY=http://user:pass@host:port`.

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
- `bot/salon_metrics.py` — вызов `node_scripts/fetch_metrics.cjs` (мост под `/send_promo`)
- `node_scripts/fetch_metrics.cjs` — Playwright для свежих метрик с карточек

Папка `node_scripts/` также содержит `salon_metrics.cjs`, `scrape_*.cjs` и связанные скрипты **пайплайна сбора/обогащения данных** для подготовки JSON с салонами; в рантайме бота для обновления метрик перед рассылкой используется **`fetch_metrics.cjs`**.

Парсинг карт **не дублирован на Python**: используется Node-модуль.

## Docker

Команды ниже выполняйте из **корня** клонированного репозитория (`cd path/to/beauty_salons_demo_bot` или ваш каталог после `git clone`).

### Локальный запуск через Docker Compose

1. Подготовьте `.env` (скопируйте `EnvExample`), `leads.json`, `applications.json`.
2. Запуск:

```bash
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
docker build -t your_dockerhub_login/beauty_salons_demo_bot:latest .
docker login
docker push your_dockerhub_login/beauty_salons_demo_bot:latest
```

### Запуск готового образа

**Linux / macOS (bash):**

```bash
docker run -d --name beauty_salons_demo_bot --restart unless-stopped \
  --env-file .env \
  -v "$(pwd)/leads.json:/app/leads.json" \
  -v "$(pwd)/applications.json:/app/applications.json" \
  your_dockerhub_login/beauty_salons_demo_bot:latest
```

**Windows (PowerShell), из каталога с `.env` и JSON:**

```powershell
docker run -d --name beauty_salons_demo_bot --restart unless-stopped `
  --env-file .env `
  -v "${PWD}/leads.json:/app/leads.json" `
  -v "${PWD}/applications.json:/app/applications.json" `
  your_dockerhub_login/beauty_salons_demo_bot:latest
```

## Тесты

```bash
pip install -r requirements-dev.txt
pytest
```

## Чему я научился на этом проекте

- Проработал полный цикл Telegram-бота: от сценария до деплоя в Docker.
- Настроил связку Python (aiogram) с Node.js (Playwright) для парсинга актуальных метрик.
- Отладил структуру проекта, чтобы его можно было быстро разворачивать под разных клиентов салонов красоты.

## Статус проекта

Проект завершён и используется как демо для переговоров с салонами красоты. Возможны доработки под конкретного клиента (CRM, интеграция с платежами и т.п.).

## Что сделать на GitHub (вручную)

Репозиторий: [github.com/sleahy115/beauty_salons_demo_bot](https://github.com/sleahy115/beauty_salons_demo_bot).

- В **About**: Description — например, `Telegram demo bot for beauty salons: leads, ROI, review funnel, promo broadcast.`; при наличии — Website (бот или личный сайт/Telegram); **Topics**: `telegram-bot`, `aiogram`, `python`, `nodejs`, `playwright`, `docker`, `beauty-salon`, `marketing`.
- Закрепить репозиторий в топе профиля GitHub как ключевой проект.
- В резюме/на HH добавить ссылку на этот репозиторий в блоке проекты и при необходимости в блоке «О себе».
