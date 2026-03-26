"""Тексты персонализированной рассылки (HTML для Telegram)."""

from __future__ import annotations


def escape_html(s: str | int | float | None) -> str:
    if s is None:
        return ""
    t = str(s)
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _v(val, default="—"):
    """Return val even if 0; use default only for None."""
    return default if val is None else val


def build_cold_outreach(
    salon: dict,
    *,
    developer_name: str = "Виталий",
    median_reviews: int | None = None,
    bot_username: str | None = None,
) -> str:
    """Короткое первое сообщение для холодной рассылки — 3-5 строк с цифрами."""
    name = escape_html(salon.get("name", ""))
    r2 = salon.get("rating2gis")
    n2 = salon.get("reviews2gis")
    ry = salon.get("ratingYandex")
    ny = salon.get("reviewsYandex")

    greeting = f"«{name}», добрый день!" if name else "Добрый день!"

    metrics_parts = []
    if n2 is not None:
        part = f"2ГИС — {n2} отз."
        if r2 is not None:
            part += f" (⭐ {r2})"
        metrics_parts.append(part)
    if ny is not None:
        part = f"Яндекс — {ny} отз."
        if ry is not None:
            part += f" (⭐ {ry})"
        metrics_parts.append(part)

    if metrics_parts:
        metrics_line = "Посмотрел карточку: " + ", ".join(metrics_parts) + "."
    else:
        metrics_line = "Посмотрел вашу карточку на картах."

    competitor_line = ""
    if median_reviews and n2 is not None and n2 < median_reviews:
        competitor_line = f"\nУ большинства салонов города — от {median_reviews}."

    bot_line = ""
    if bot_username:
        bot_line = f"\n\n👉 Демо за 2 мин: @{escape_html(bot_username)}"

    return (
        f"{greeting}\n\n"
        f"{metrics_line}"
        f"{competitor_line}\n\n"
        f"Делаю Telegram-бот, который автоматически собирает отзывы "
        f"с реальных клиентов после визита. Бесплатно покажу, как работает."
        f"{bot_line}\n\n"
        f"Интересно?\n"
        f"— {escape_html(developer_name)}"
    )


def build_promo_message(
    m: dict,
    owner_name: str | None,
    salon_name: str | None,
) -> str:
    """Полное промо-сообщение (для бота после /start или /send_promo)."""
    salon = (salon_name or "").strip() or "ваш салон"
    salon_esc = escape_html(salon)

    ry = m.get("ratingYandex")
    r2 = m.get("rating2gis")
    ny = m.get("reviewsYandex")
    n2 = m.get("reviews2gis")

    has_data = any(v is not None for v in (ry, r2, ny, n2))

    metrics_block = ""
    if has_data:
        parts = []
        if n2 is not None or r2 is not None:
            parts.append(f"2ГИС: ⭐ {_v(r2)} ({n2 if n2 is not None else '?'} отз.)")
        if ny is not None or ry is not None:
            parts.append(f"Яндекс: ⭐ {_v(ry)} ({ny if ny is not None else '?'} отз.)")
        metrics_block = (
            f"\n📊 <b>«{salon_esc}» сейчас:</b>\n"
            + "\n".join(f"    • {p}" for p in parts)
            + "\n"
        )

    return (
        f"Здравствуйте!\n\n"
        f"Ваши клиенты выбирают салон по отзывам на картах. "
        f"Мало отзывов = мало доверия = потерянные записи."
        f"{metrics_block}\n"
        f"Этот бот автоматизирует сбор отзывов:\n"
        f"1️⃣ клиент оценивает визит,\n"
        f"2️⃣ оставляет отзыв на Яндексе или 2ГИС,\n"
        f"3️⃣ присылает скрин → получает скидку 🎯\n\n"
        f"Вы видите статистику и модерируете одной кнопкой.\n\n"
        f"🚀 Нажмите <b>«Запустить демо»</b> — пройдёте путь клиента за 2 минуты."
    )
