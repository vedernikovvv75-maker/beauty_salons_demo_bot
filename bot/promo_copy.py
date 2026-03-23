"""Тексты персонализированной рассылки (HTML для Telegram)."""


def escape_html(s: str | int | float | None) -> str:
    if s is None:
        return ""
    t = str(s)
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fmt(n):
    if n is None or n == "":
        return None
    return n


def build_fallback_no_data(name: str, salon_esc: str) -> str:
    greet = f"Здравствуйте, {escape_html(name)}!" if name.strip() else "Здравствуйте!"
    return (
        f"{greet}\n\n"
        f"Хотите увеличить число отзывов о <b>«{salon_esc}»</b> на Яндекс.Картах и 2ГИС?\n\n"
        f"Наш бот собирает отзывы после визита и ведёт клиента к публикации, а вы контролируете выдачу скидки.\n\n"
        f"🚀 <b>Запустить демо</b> — посмотрите, как это работает."
    )


def build_promo_message(m: dict, owner_name: str | None, salon_name: str | None) -> str:
    name = (owner_name or "").strip()
    salon = (salon_name or "").strip() or "ваш салон"
    salon_esc = escape_html(salon)
    ry = m.get("ratingYandex")
    r2 = m.get("rating2gis")
    ny = m.get("reviewsYandex")
    n2 = m.get("reviews2gis")

    has_data = (ry is not None or r2 is not None) or (ny is not None or n2 is not None)
    if not has_data:
        return build_fallback_no_data(name, salon_esc)

    low_reviews_y = ny is not None and ny < 20
    low_reviews_2 = n2 is not None and n2 < 20
    low_rating_y = ry is not None and ry < 4.5
    low_rating_2 = r2 is not None and r2 < 4.5
    problem_low_reviews = low_reviews_y or low_reviews_2
    problem_low_rating = low_rating_y or low_rating_2

    yandex_line = (
        f"• Яндекс.Карты: ⭐ {fmt(ry) or '—'} ({f'{ny} отзывов/оценок' if ny is not None else 'нет данных'})"
        if ry is not None or ny is not None
        else "• Яндекс.Карты: нет данных (возможна капча или сбой)"
    )
    gis_line = (
        f"• 2ГИС: ⭐ {fmt(r2) or '—'} ({f'{n2} оценок' if n2 is not None else 'нет данных'})"
        if r2 is not None or n2 is not None
        else "• 2ГИС: нет данных"
    )

    greet_named = (
        f"Здравствуйте, {escape_html(name)}! 👋" if name else "Здравствуйте! 👋"
    )
    greet_short = f"Здравствуйте, {escape_html(name)}!" if name else "Здравствуйте!"

    if problem_low_reviews and (ry is not None or r2 is not None):
        return (
            f"{greet_named}\n\n"
            f"Салон <b>«{salon_esc}»</b> — сильный сервис, но на картах мало отзывов или они не дотягивают до ожиданий поиска.\n\n"
            f"📊 <b>Текущие показатели:</b>\n"
            f"{yandex_line}\n"
            f"{gis_line}\n\n"
            f"Потенциальные клиенты чаще выбирают точки с рейтингом выше 4.5 и заметным числом отзывов.\n\n"
            f"✅ <b>Решение:</b> бот автоматически собирает реальные отзывы после визита и мотивирует клиента скидкой. "
            f"За пару месяцев можно заметно подтянуть карточку на картах.\n\n"
            f"Нажмите «🚀 Запустить демо» — покажу весь путь клиента в демо-режиме."
        )

    ny_v = ny if ny is not None else 0
    n2_v = n2 if n2 is not None else 0
    if (
        not problem_low_rating
        and not problem_low_reviews
        and ny_v >= 20
        and n2_v >= 20
    ):
        return (
            f"{greet_short}\n\n"
            f"У <b>«{salon_esc}»</b> сильная карточка: заметный рейтинг и объём отзывов.\n\n"
            f"📊 <b>Текущие показатели:</b>\n"
            f"{yandex_line}\n"
            f"{gis_line}\n\n"
            f"Чтобы удерживать лидерство, важно регулярно получать свежие отзывы — бот снимает эту нагрузку с администраторов.\n\n"
            f"🚀 <b>Запустить демо</b> — посмотрите, как это выглядит для клиента."
        )

    if (ry is not None and ry >= 4.5) or (r2 is not None and r2 >= 4.5):
        return (
            f"{greet_short}\n\n"
            f"У <b>«{salon_esc}»</b> высокий рейтинг, но по числу отзывов карточку ещё можно усилить.\n\n"
            f"📊 <b>Текущие показатели:</b>\n"
            f"{yandex_line}\n"
            f"{gis_line}\n\n"
            f"Клиенты доверяют салонам с большим числом отзывов — это напрямую влияет на просмотры в поиске.\n\n"
            f"✅ <b>Решение:</b> бот помогает собрать отзыв у каждого довольного гостя. 🚀 <b>Запустить демо</b> — увидите сценарий целиком."
        )

    return (
        f"{greet_short}\n\n"
        f"Салон <b>«{salon_esc}»</b> — посмотрите актуальные цифры на картах:\n\n"
        f"📊 <b>Текущие показатели:</b>\n"
        f"{yandex_line}\n"
        f"{gis_line}\n\n"
        f"✅ Автоматический сбор отзывов и мягкая мотивация клиента скидкой помогают расти без «накруток».\n\n"
        f"🚀 <b>Запустить демо</b> — покажу механику в демо-режиме."
    )
