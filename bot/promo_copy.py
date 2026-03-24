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


def build_promo_message(m: dict, owner_name: str | None, salon_name: str | None) -> str:
    salon = (salon_name or "").strip() or "ваш салон"
    salon_esc = escape_html(salon)

    ry = m.get("ratingYandex")
    r2 = m.get("rating2gis")
    ny = m.get("reviewsYandex")
    n2 = m.get("reviews2gis")

    has_data = any(v is not None for v in (ry, r2, ny, n2))

    metrics_block = ""
    if has_data:
        yandex_line = (
            f"    • Яндекс.Карты: ⭐ {_v(ry)} ({f'{ny} отзывов' if ny is not None else 'нет данных'})"
            if ry is not None or ny is not None
            else "    • Яндекс.Карты: нет данных"
        )
        gis_line = (
            f"    • 2ГИС: ⭐ {_v(r2)} ({f'{n2} отзывов' if n2 is not None else 'нет данных'})"
            if r2 is not None or n2 is not None
            else "    • 2ГИС: нет данных"
        )
        metrics_block = (
            f"\n📊 <b>Текущие показатели «{salon_esc}»:</b>\n"
            f"{yandex_line}\n"
            f"{gis_line}\n"
        )

    return (
        "Здравствуйте, коллега!\n\n"
        "Меня зовут Виталий 👋\n"
        "Я разработчик этого бота.\n\n"
        "😶 Ваши потенциальные клиенты практически всегда "
        "ориентируются на отзывы в Яндекс.Картах и 2ГИС. Если отзывов нет или их мало, "
        "это также отпугивает посетителей, как и наличие отрицательных отзывов\n\n"
        "Однако собирать отзывы даже с довольных посетителей сложно. Они обещают оставить, "
        "потом их внимание рассеивается, и про отзыв забывают. А вам напоминать неудобно — "
        "вы понимаете, человек уже занят другими делами.\n"
        f"{metrics_block}\n"
        "Посмотрите, как автоматизировать сбор свежих отзывов:\n\n"
        "1️⃣ гость оценивает визит по 5-балльной шкале,\n"
        "2️⃣ оставляет отзыв,\n"
        "3️⃣ отправляет скрин опубликованного отзыва и\n"
        "4️⃣ получает скидку 10% 🎯\n\n"
        "💸 Сейчас в демо-режиме вы как будто бы клиент вашего же салона "
        "и пройдёте весь путь от оценки услуг до получения скидки\n\n"
        "📊 После этого вы увидите, какие уведомления "
        "приходят вам и какие показатели по отзывам и скидкам бот собирает\n\n"
        "Бот не тупит, не выгорает, не устаёт.\n"
        "🚀 Нажмите кнопку <b>«Запустить демо»</b>, чтобы увидеть, "
        "как это может работать на вас"
    )
