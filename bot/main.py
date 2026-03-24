"""
Telegram-бот: демо сбора отзывов, продажи, рассылка /send_promo.

Запуск: python -m bot.main  (из корня проекта D:\\vibe-coding\\beauty-salons)
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import BaseFilter, Command
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)

from . import activity_log, config
from .leads_store import append_application, load_leads, save_leads
from .promo_copy import build_promo_message, escape_html
from .salon_metrics import fetch_salon_metrics_fresh

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _v(val, default: str = "—"):
    """Return val even if 0; use default only for None."""
    return default if val is None else val


def _plural(n: int, one: str, few: str, many: str) -> str:
    n_abs = abs(n)
    if 11 <= n_abs % 100 <= 19:
        return f"{n} {many}"
    mod10 = n_abs % 10
    if mod10 == 1:
        return f"{n} {one}"
    if 2 <= mod10 <= 4:
        return f"{n} {few}"
    return f"{n} {many}"

router = Router()

sessions: dict[int, dict] = {}
pending_screens: dict[str, dict] = {}
_demo_viewer_chat_id: int | None = None
_hot_salons: list[dict] = []


def _load_hot_salons() -> list[dict]:
    src = Path(__file__).resolve().parent.parent / "barnaul_salons_all.json"
    if not src.exists():
        logger.warning("barnaul_salons_all.json not found — demo will use config defaults")
        return []
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    result = []
    for s in data.get("salons", []):
        if not s.get("url2gis") or not s.get("urlYandex"):
            continue
        ry = s.get("reviewsYandex")
        r2 = s.get("reviews2gis")
        low_y = ry is None or ry < 20
        low_2 = r2 is None or r2 < 20
        if low_y or low_2:
            result.append(s)
    logger.info("Hot salons loaded: %d of %d", len(result), len(data.get("salons", [])))
    return result



def _categorize_salons(exclude_sent: bool = True) -> dict[str, list[dict]]:
    src = Path(__file__).resolve().parent.parent / "barnaul_salons_all.json"
    if not src.exists():
        return {"hot": [], "warm": [], "cold": []}
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    sent_ids = activity_log.get_sent_salon_ids() if exclude_sent else set()
    hot, warm, cold = [], [], []
    for s in data.get("salons", []):
        if not s.get("telegram"):
            continue
        if s.get("id") in sent_ids:
            continue
        ry = s.get("reviewsYandex")
        r2 = s.get("reviews2gis")
        low_y = ry is None or ry < 20
        low_2 = r2 is None or r2 < 20
        if low_y or low_2:
            hot.append(s)
        elif (ry is not None and ry <= 50) or (r2 is not None and r2 <= 50):
            warm.append(s)
        else:
            cold.append(s)
    return {"hot": hot, "warm": warm, "cold": cold}


def pick_demo_salon() -> dict | None:
    if not _hot_salons:
        return None
    return random.choice(_hot_salons)


def get_viewer_chat_id() -> int | None:
    if _demo_viewer_chat_id is not None:
        return _demo_viewer_chat_id
    raw = config.ADMIN_GROUP_CHAT_ID
    return int(raw) if raw else None


class DemoNegativeTextFilter(BaseFilter):
    async def __call__(self, message: Message) -> bool:
        if not message.from_user:
            return False
        return get_session(message.from_user.id)["step"] in (
            "demo_negative_text",
            "demo_negative_text_2",
        )


def get_session(uid: int) -> dict:
    if uid not in sessions:
        sessions[uid] = {"step": "idle"}
    return sessions[uid]


def set_step(uid: int, step: str) -> None:
    get_session(uid)["step"] = step


def is_admin(user_id: int) -> bool:
    return bool(config.ADMIN_IDS) and user_id in config.ADMIN_IDS


def welcome_text() -> str:
    return build_promo_message({}, None, None)


async def send_stats_and_sales(message_or_bot, uid: int | None = None, chat_id: int | None = None) -> None:
    if isinstance(message_or_bot, Message):
        bot = message_or_bot.bot
        chat_id = message_or_bot.chat.id
    else:
        bot = message_or_bot

    if uid:
        activity_log.log_event(uid, "stats_viewed")
    ds = _get_demo_salon(uid) if uid else {}
    salon_name = escape_html(ds.get("name", "ваш салон"))

    ry = ds.get("ratingYandex")
    r2 = ds.get("rating2gis")
    ny = ds.get("reviewsYandex")
    n2 = ds.get("reviews2gis")

    reviews_block = ""
    if ny is not None or n2 is not None:
        parts = []
        if ny is not None:
            parts.append(f"Яндекс: <b>{ny}</b> (рейтинг {_v(ry)})")
        if n2 is not None:
            parts.append(f"2ГИС: <b>{n2}</b> (рейтинг {_v(r2)})")
        reviews_block = (
            f"\n📊 <b>Текущие отзывы «{salon_name}»:</b>\n"
            + "\n".join(f"    • {p}" for p in parts)
            + "\n"
        )

    await bot.send_message(
        chat_id,
        "🖥️ <b>Как это выглядит для руководителя</b>\n\n"
        "Это был один проход. В реальности всё стекается в таблицу.\n\n"
        "Пример «панели» за месяц (демо-цифры):\n"
        "✅ Положительных оценок (4–5): <b>82%</b>\n"
        "📝 Скринов на проверке: <b>3</b>\n"
        "💰 Выдано скидок: <b>145</b>\n"
        "🚨 Отработано негатива: <b>2</b> инцидента\n"
        "📈 Новых отзывов за месяц: <b>+38</b>\n"
        "    • 😊 позитивных: <b>34</b>\n"
        "    • 😐 нейтральных: <b>3</b>\n"
        "    • 😠 негативных: <b>1</b> (отработан)\n"
        f"{reviews_block}\n"
        "Дальше — выгода и форматы сотрудничества.",
        parse_mode="HTML",
    )
    await send_roi_block(bot, chat_id, uid)


async def send_roi_block(bot_or_msg, chat_id: int | None = None, uid: int | None = None) -> None:
    if isinstance(bot_or_msg, Message):
        bot = bot_or_msg.bot
        chat_id = bot_or_msg.chat.id
        uid = uid or bot_or_msg.from_user.id
    else:
        bot = bot_or_msg
    set_step(uid, "sales_roi")
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="До 50", callback_data="roi:50"),
                InlineKeyboardButton(text="50–150", callback_data="roi:150"),
            ],
            [InlineKeyboardButton(text="Более 150", callback_data="roi:more")],
        ]
    )
    await bot.send_message(
        chat_id,
        "💰 <b>Посчитаем выгоду для вашего салона</b>\n\n"
        "Сколько клиентов в среднем у вас в месяц?",
        parse_mode="HTML",
        reply_markup=kb,
    )


async def send_packages_block(message: Message) -> None:
    set_step(message.from_user.id, "sales_packages")
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Старт", callback_data="pkg:start")],
            [InlineKeyboardButton(text="Бизнес", callback_data="pkg:biz")],
            [InlineKeyboardButton(text="Безопасность (доп.)", callback_data="pkg:sec")],
        ]
    )
    await message.answer(
        "📦 <b>Варианты внедрения</b>\n\n"
        "Выберите формат — пришлю детали сообщением.",
        parse_mode="HTML",
        reply_markup=kb,
    )


async def send_cta_block(message: Message) -> None:
    set_step(message.from_user.id, "sales_cta")
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="🔍 Заказать бесплатный аудит салона", callback_data="cta:audit")],
            [
                InlineKeyboardButton(
                    text="🚀 Получить «Старт» за 50%",
                    callback_data="cta:setup",
                )
            ],
        ]
    )
    await message.answer(
        "🎁 <b>Что дальше</b>\n\n"
        "🔍 <b>«Заказать бесплатный аудит салона»</b> — бесплатное предложение. "
        "Я как разработчик смотрю текущие показатели салона на картах "
        "(отзывы, рейтинг, конкурентов) и даю владельцу краткий отчёт с рекомендациями. "
        "Это не обязывает вас к заказу.\n\n"
        "🚀 <b>«Получить «Старт» за 50%»</b> — коммерческое предложение со скидкой. "
        "Вы записываетесь на настройку бота по тарифу «Старт» за полцены — 5 000 ₽ вместо 10 000 ₽.",
        parse_mode="HTML",
        reply_markup=kb,
    )
    contact_kb = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📞 Оставить телефон", request_contact=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
    )
    await message.answer(
        "📞 Или просто оставьте телефон — перезвоню в удобное время.",
        parse_mode="HTML",
        reply_markup=contact_kb,
    )


async def start_demo_rating(message: Message) -> None:
    set_step(message.from_user.id, "demo_rating")
    kb = InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(text="☆", callback_data="rate:1"),
            InlineKeyboardButton(text="☆", callback_data="rate:2"),
            InlineKeyboardButton(text="☆", callback_data="rate:3"),
            InlineKeyboardButton(text="☆", callback_data="rate:4"),
            InlineKeyboardButton(text="☆", callback_data="rate:5"),
        ]]
    )
    await message.answer(
        "🧪 <i>Демо-режим</i>\n\n"
        "Представьте, что клиент только что вышел от мастера.\n\n"
        "Дважды «тапните» на крайнюю звезду, как будто вы клиент.\n\n"
        "<b>Оцените качество услуги:</b>",
        parse_mode="HTML",
        reply_markup=kb,
    )


async def after_positive_done(bot: Bot, user_id: int, chat_id: int) -> None:
    s = get_session(user_id)
    s["done_positive"] = True
    if s.get("done_negative"):
        set_step(user_id, "after_negative")
        await send_stats_and_sales(bot, uid=user_id, chat_id=chat_id)
        return
    set_step(user_id, "after_positive")
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Сымитировать негатив", callback_data="demo_negative_next")]
        ]
    )
    await bot.send_message(
        chat_id,
        "<i>Теперь можно посмотреть <b>негативный сценарий</b> — как бот забирает недовольство до публичного отзыва.</i>",
        parse_mode="HTML",
        reply_markup=kb,
    )


@router.message(Command("start"))
async def cmd_start(message: Message) -> None:
    u = message.from_user
    activity_log.log_event(u.id, "start", username=u.username, first_name=u.first_name)
    set_step(u.id, "idle")
    rk = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="Запустить демо")]],
        resize_keyboard=True,
    )
    await message.answer(welcome_text(), parse_mode="HTML", reply_markup=rk)


def _assign_demo_salon(uid: int) -> None:
    salon = pick_demo_salon()
    s = get_session(uid)
    s.pop("done_positive", None)
    s.pop("done_negative", None)
    s.pop("_rate_confirmed", None)
    if salon:
        s["demo_salon"] = salon
    else:
        s["demo_salon"] = {
            "name": config.DEMO_SALON_NAME,
            "url2gis": config.MAP_LINK_2GIS,
            "urlYandex": config.MAP_LINK_YANDEX,
        }


def _get_demo_salon(uid: int) -> dict:
    ds = get_session(uid).get("demo_salon") or {
        "name": config.DEMO_SALON_NAME,
        "url2gis": config.MAP_LINK_2GIS,
        "urlYandex": config.MAP_LINK_YANDEX,
        "url2gisReviews": config.MAP_LINK_2GIS,
        "urlYandexReviews": config.MAP_LINK_YANDEX,
    }
    return ds


@router.message(F.text.casefold() == "запустить демо")
async def hears_demo(message: Message) -> None:
    u = message.from_user
    activity_log.log_event(u.id, "demo_started", username=u.username, first_name=u.first_name)
    _assign_demo_salon(u.id)
    await start_demo_rating(message)


@router.message(Command("set_viewer"))
async def cmd_set_viewer(message: Message) -> None:
    global _demo_viewer_chat_id
    if not is_admin(message.from_user.id):
        await message.answer("Команда только для администраторов.")
        return
    parts = (message.text or "").split()
    if len(parts) < 2:
        current = get_viewer_chat_id()
        await message.answer(
            f"Текущий получатель модерации: <b>{current or 'не задан'}</b>\n\n"
            "Использование:\n"
            "<code>/set_viewer 123456789</code> — задать chat_id\n"
            "<code>/set_viewer off</code> — сбросить на ADMIN_GROUP_CHAT_ID из .env",
            parse_mode="HTML",
        )
        return
    arg = parts[1].strip()
    if arg.lower() == "off":
        _demo_viewer_chat_id = None
        await message.answer("Получатель сброшен на значение из .env.", parse_mode="HTML")
        return
    try:
        _demo_viewer_chat_id = int(arg)
    except ValueError:
        await message.answer("Передайте числовой chat_id или <code>off</code>.", parse_mode="HTML")
        return
    await message.answer(
        f"Модерация теперь идёт в <b>{_demo_viewer_chat_id}</b>.",
        parse_mode="HTML",
    )


@router.message(Command("help"))
async def cmd_help(message: Message) -> None:
    admin = is_admin(message.from_user.id)
    extra = "/send_promo — рассылка\n/set_viewer — куда шлём модерацию\n/adm — трекер лидов\n" if admin else ""
    await message.answer(
        f"Команды:\n/start — сначала\n{extra}\nДемо показывает путь клиента и уведомления админам."
    )


_ACTION_LABELS = {
    "start": "/start",
    "demo_started": "демо",
    "rated": "оценка",
    "screenshot_sent": "скрин",
    "screenshot_approved": "одобрен",
    "screenshot_rejected": "отклонён",
    "negative_text": "негатив",
    "stats_viewed": "статистика",
    "cta_audit": "CTA аудит",
    "cta_setup": "CTA настройка",
    "phone_shared": "телефон",
}


def _relative_time(iso_ts: str) -> str:
    try:
        dt = datetime.fromisoformat(iso_ts)
        delta = datetime.now(timezone.utc) - dt
        mins = int(delta.total_seconds() // 60)
        if mins < 1:
            return "только что"
        if mins < 60:
            return f"{mins}мин назад"
        hours = mins // 60
        if hours < 24:
            return f"{hours}ч назад"
        days = hours // 24
        return f"{days}д назад"
    except Exception:
        return iso_ts


def _fmt_time_short(iso_ts: str) -> str:
    try:
        dt = datetime.fromisoformat(iso_ts)
        msk_dt = dt.astimezone(timezone(timedelta(hours=3)))
        return msk_dt.strftime("%H:%M")
    except Exception:
        return "?"


@router.message(Command("adm"))
async def cmd_adm(message: Message) -> None:
    if not is_admin(message.from_user.id):
        await message.answer("Команда только для администраторов.")
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="📋 Лид-трекер", callback_data="adm:tracker"),
            InlineKeyboardButton(text="📤 Рассылка", callback_data="adm:broadcast"),
        ]
    ])
    await message.answer("<b>Панель администратора</b>", parse_mode="HTML", reply_markup=kb)


async def _send_tracker(target: Message | CallbackQuery, full_mode: bool = False) -> None:
    users = activity_log.get_all_users()
    msg = target.message if isinstance(target, CallbackQuery) else target
    if not users:
        await msg.answer("Лид-трекер пуст. Пока никто не взаимодействовал с ботом.")
        return
    lines = ["<b>--- Лид-трекер ---</b>\n"]
    for uid_str, u in users.items():
        uname = u.get("username")
        fname = u.get("first_name") or ""
        header = f"@{escape_html(uname)}" if uname else escape_html(fname) or uid_str
        header += f" (id {uid_str})"
        events = u.get("events", [])
        if not events:
            lines.append(f"{header}\n  нет действий\n")
            continue
        if full_mode:
            lines.append(header)
            for ev in events:
                label = _ACTION_LABELS.get(ev["action"], ev["action"])
                t = _fmt_time_short(ev["ts"])
                detail = f' "{ev["detail"]}"' if ev.get("detail") else ""
                lines.append(f"  {t} {label}{detail}")
        else:
            milestones = []
            for ev in events:
                label = _ACTION_LABELS.get(ev["action"], ev["action"])
                t = _fmt_time_short(ev["ts"])
                detail = f" {ev['detail']}" if ev.get("detail") and ev["action"] == "rated" else ""
                milestones.append(f"{label}{detail} {t}")
            lines.append(header)
            lines.append("  " + " | ".join(milestones))
        has_setup = any(e["action"] == "cta_setup" for e in events)
        has_audit = any(e["action"] == "cta_audit" for e in events)
        if has_setup:
            lines.append("  <b>ЗАЯВКА НА НАСТРОЙКУ</b>")
        elif has_audit:
            lines.append("  заявка на аудит")
        last_ts = events[-1]["ts"]
        lines.append(f"  Последнее действие: {_relative_time(last_ts)}\n")
    text = "\n".join(lines)
    if len(text) > 4000:
        for i in range(0, len(text), 4000):
            await msg.answer(text[i:i + 4000], parse_mode="HTML")
    else:
        await msg.answer(text, parse_mode="HTML")


@router.callback_query(F.data == "adm:tracker")
async def cb_adm_tracker(query: CallbackQuery) -> None:
    if not is_admin(query.from_user.id):
        await query.answer("Нет доступа", show_alert=True)
        return
    await query.answer()
    await _send_tracker(query)


@router.callback_query(F.data == "adm:broadcast")
async def cb_adm_broadcast(query: CallbackQuery) -> None:
    if not is_admin(query.from_user.id):
        await query.answer("Нет доступа", show_alert=True)
        return
    await query.answer()
    cats = _categorize_salons(exclude_sent=True)
    total_sent = len(activity_log.get_sent_salon_ids())
    total_remaining = len(cats["hot"]) + len(cats["warm"]) + len(cats["cold"])
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text=f"🔴 Горячие ({len(cats['hot'])})",
            callback_data="adm:cat:hot",
        )],
        [InlineKeyboardButton(
            text=f"🟡 Тёплые ({len(cats['warm'])})",
            callback_data="adm:cat:warm",
        )],
        [InlineKeyboardButton(
            text=f"🔵 Холодные ({len(cats['cold'])})",
            callback_data="adm:cat:cold",
        )],
    ])
    await query.message.answer(
        "<b>Рассылка — выберите категорию лидов</b>\n\n"
        f"📊 Отправлено: <b>{total_sent}</b> | Осталось: <b>{total_remaining}</b>\n\n"
        "🔴 <b>Горячие</b> — мало отзывов (любой показатель &lt; 20)\n"
        "🟡 <b>Тёплые</b> — от 20 до 50 отзывов\n"
        "🔵 <b>Холодные</b> — более 50 отзывов",
        parse_mode="HTML",
        reply_markup=kb,
    )


def _extract_address(salon: dict) -> str:
    other = salon.get("other", "")
    for part in other.split("|"):
        part = part.strip()
        if part.lower().startswith("адрес:"):
            return part[6:].strip()
    return "—"


def _extract_tg_contact(salon: dict) -> str:
    tg = salon.get("telegram", "")
    if not tg:
        return "—"
    return tg


async def _show_salon_card(bot: Bot, chat_id: int, salon: dict, idx: int, total: int) -> None:
    name = escape_html(salon.get("name", "?"))
    address = escape_html(_extract_address(salon))
    tg = salon.get("telegram", "")
    ry = salon.get("ratingYandex")
    r2 = salon.get("rating2gis")
    ny = salon.get("reviewsYandex")
    n2 = salon.get("reviews2gis")

    y_part = f"⭐ {_v(ry)} ({_v(ny, 0)} отз.)" if ry is not None or ny is not None else "нет данных"
    g_part = f"⭐ {_v(r2)} ({_v(n2, 0)} отз.)" if r2 is not None or n2 is not None else "нет данных"

    text = (
        f"<b>Салон {idx + 1}/{total}</b>\n\n"
        f"🏠 <b>{name}</b>\n"
        f"📍 {address}\n"
        f"📱 TG: {escape_html(tg) if tg else '—'}\n\n"
        f"Яндекс: {y_part}\n"
        f"2ГИС: {g_part}"
    )
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Отправить бота", callback_data=f"adm:send:{idx}"),
            InlineKeyboardButton(text="⏭ Пропустить", callback_data=f"adm:skip:{idx}"),
        ],
        [InlineKeyboardButton(text="🔚 Завершить", callback_data="adm:done")],
    ])
    await bot.send_message(chat_id, text, parse_mode="HTML", reply_markup=kb)


@router.callback_query(F.data.startswith("adm:cat:"))
async def cb_adm_cat(query: CallbackQuery) -> None:
    if not is_admin(query.from_user.id):
        await query.answer("Нет доступа", show_alert=True)
        return
    await query.answer()
    cat = query.data.split(":")[2]
    cats = _categorize_salons()
    salons = cats.get(cat, [])
    if not salons:
        await query.message.answer("В этой категории нет салонов с Telegram.")
        return
    uid = query.from_user.id
    s = get_session(uid)
    s["adm_queue"] = salons
    s["adm_idx"] = 0
    await _show_salon_card(query.bot, query.message.chat.id, salons[0], 0, len(salons))


@router.callback_query(F.data.startswith("adm:send:"))
async def cb_adm_send(query: CallbackQuery) -> None:
    if not is_admin(query.from_user.id):
        await query.answer("Нет доступа", show_alert=True)
        return
    await query.answer()
    uid = query.from_user.id
    s = get_session(uid)
    queue = s.get("adm_queue", [])
    idx = int(query.data.split(":")[2])
    if idx >= len(queue):
        await query.message.answer("Список закончился.")
        return
    salon = queue[idx]
    tg = salon.get("telegram", "")
    name = salon.get("name", "?")
    salon_id = salon.get("id", "")

    await query.message.answer("⏳ Парсим актуальные метрики…")
    try:
        metrics = await fetch_salon_metrics_fresh(
            url2gis=salon.get("url2gis"),
            urlYandex=salon.get("urlYandex"),
            name=name,
            skipYandex=not (salon.get("urlYandex") or name),
        )
    except Exception as e:
        logger.exception("Fresh metrics failed for %s: %s", name, e)
        metrics = {
            "ratingYandex": salon.get("ratingYandex"),
            "reviewsYandex": salon.get("reviewsYandex"),
            "rating2gis": salon.get("rating2gis"),
            "reviews2gis": salon.get("reviews2gis"),
        }
    promo_text = build_promo_message(metrics, None, name)

    await query.message.answer(
        f"📨 <b>Промо для «{escape_html(name)}»:</b>\n\n"
        f"{promo_text}\n\n"
        "---\n"
        f"📱 Отправьте вручную: {escape_html(tg)}",
        parse_mode="HTML",
    )

    if salon_id:
        activity_log.mark_salon_sent(salon_id)
    total_sent = len(activity_log.get_sent_salon_ids())
    cats = _categorize_salons(exclude_sent=True)
    remaining = len(cats["hot"]) + len(cats["warm"]) + len(cats["cold"])
    await query.message.answer(
        f"✅ Бот отправлен «{escape_html(name)}».\n\n"
        f"📊 Всего отправлено: <b>{total_sent}</b> | Осталось: <b>{remaining}</b>\n"
        f"   🔴 горячих: {len(cats['hot'])} | 🟡 тёплых: {len(cats['warm'])} | 🔵 холодных: {len(cats['cold'])}",
        parse_mode="HTML",
    )


@router.callback_query(F.data.startswith("adm:skip:"))
async def cb_adm_skip(query: CallbackQuery) -> None:
    if not is_admin(query.from_user.id):
        await query.answer("Нет доступа", show_alert=True)
        return
    await query.answer()
    uid = query.from_user.id
    s = get_session(uid)
    queue = s.get("adm_queue", [])
    idx = int(query.data.split(":")[2])
    next_idx = idx + 1
    if next_idx < len(queue):
        s["adm_idx"] = next_idx
        await _show_salon_card(query.bot, query.message.chat.id, queue[next_idx], next_idx, len(queue))
    else:
        await query.message.answer("Список этой категории завершён.")


@router.callback_query(F.data == "adm:done")
async def cb_adm_done(query: CallbackQuery) -> None:
    if not is_admin(query.from_user.id):
        await query.answer("Нет доступа", show_alert=True)
        return
    await query.answer()
    s = get_session(query.from_user.id)
    s.pop("adm_queue", None)
    s.pop("adm_idx", None)
    await query.message.answer("Рассылка завершена.")


def _stars_kb(selected: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(
                text="⭐" if i <= selected else "☆",
                callback_data=f"rate:{i}",
            )
            for i in range(1, 6)
        ]]
    )


@router.callback_query(F.data.startswith("rate:"))
async def cb_rate(query: CallbackQuery) -> None:
    await query.answer()
    n = int(query.data.split(":")[1])
    uid = query.from_user.id
    s = get_session(uid)

    if s["step"] in ("demo_rating", "demo_neg_second") and s.get("_rate_confirmed") != n:
        s["_rate_confirmed"] = n
        stars_text = "⭐" * n + "☆" * (5 - n)
        await query.message.edit_reply_markup(reply_markup=_stars_kb(n))
        return

    s.pop("_rate_confirmed", None)
    activity_log.log_event(uid, "rated", username=query.from_user.username, detail=str(n))

    if s["step"] == "demo_rating":
        if n >= 4:
            set_step(uid, "demo_positive")
            ds = _get_demo_salon(uid)
            kb = InlineKeyboardMarkup(
                inline_keyboard=[
                    [InlineKeyboardButton(text="Отзыв на Яндекс.Картах", url=ds["urlYandexReviews"])],
                    [InlineKeyboardButton(text="Отзыв на 2ГИС", url=ds["url2gisReviews"])],
                    [InlineKeyboardButton(text="Готов отправить скрин", callback_data="ready_screen")],
                ]
            )
            salon_name = escape_html(ds.get("name", "салон"))
            metrics_line = ""
            ry = ds.get("ratingYandex")
            r2 = ds.get("rating2gis")
            ny = ds.get("reviewsYandex")
            n2 = ds.get("reviews2gis")
            parts = []
            if ry is not None or ny is not None:
                parts.append(f"Яндекс: ⭐ {_v(ry)} ({_plural(_v(ny, 0), 'отзыв', 'отзыва', 'отзывов')})")
            if r2 is not None or n2 is not None:
                parts.append(f"2ГИС: ⭐ {_v(r2)} ({_plural(_v(n2, 0), 'отзыв', 'отзыва', 'отзывов')})")
            if parts:
                metrics_line = "\n📊 " + " | ".join(parts) + "\n"
            await query.message.edit_text(
                "🧪 <i>Демо-режим</i>\n\n"
                f"Рады, что вам понравилось. Чтобы получить скидку 10% на следующий визит, "
                f"оставьте отзыв о салоне <b>«{salon_name}»</b> на картах и пришлите скрин опубликованного отзыва."
                f"{metrics_line}\n"
                "Откройте ссылку или нажмите «Готов отправить скрин», когда оставите отзыв.",
                parse_mode="HTML",
                reply_markup=kb,
            )
        else:
            set_step(uid, "demo_negative_text")
            await query.message.edit_text(
                "🧪 <i>Демо-режим</i>\n\n"
                "Нам жаль, что впечатление смазалось. Напишите одним сообщением, что пошло не так — "
                "<i> реально в боевом боте это уйдёт руководителю, чтобы разобраться в ситуации.</i>",
                parse_mode="HTML",
            )
        return

    if s["step"] == "demo_neg_second":
        set_step(uid, "demo_negative_text_2")
        await query.message.edit_text(
            "🧪 <i>Демо-режим — негатив</i>\n\n"
            "Что случилось? Опишите в двух словах:",
            parse_mode="HTML",
        )


@router.callback_query(F.data == "ready_screen")
async def cb_ready_screen(query: CallbackQuery) -> None:
    await query.answer()
    set_step(query.from_user.id, "demo_wait_screenshot")
    await query.message.answer(
        "Отправьте скриншот отзыва в этот чат. Вы можете отправить любое фото — покажу модерацию.\n\n"
        "<i>В реальности, когда человек отправит недействительный скриншот, вы его отклоните "
        "и пользователь в боте получит соответствующее сообщение. Это контролирует получение скидок.\n\n"
        "У клиента есть возможность отправить скрин только один раз (либо Яндекс.Карты, либо 2ГИС). "
        "Это защищает от злоупотреблений клиентами в получении скидки на посещение салона "
        "и подозрения на накрутку от картографических сервисов. "
        "Один клиент — один отзыв и никаких проблем с модерацией отзывов на площадке.\n\n"
        "Да, и не забудьте отправить скриншот, нажав на скрепку </i>📎",
        parse_mode="HTML",
    )


@router.callback_query(F.data == "start_demo")
async def cb_start_demo(query: CallbackQuery) -> None:
    await query.answer()
    if not query.message:
        return
    u = query.from_user
    activity_log.log_event(u.id, "demo_started", username=u.username, first_name=u.first_name)
    _assign_demo_salon(u.id)
    await start_demo_rating(query.message)


@router.callback_query(F.data == "skip_screen_resubmit")
async def cb_skip_screen_resubmit(query: CallbackQuery) -> None:
    await query.answer()
    uid = query.from_user.id
    await after_positive_done(query.bot, uid, query.message.chat.id)


@router.callback_query(F.data == "demo_negative_next")
async def cb_demo_neg_next(query: CallbackQuery) -> None:
    await query.answer()
    set_step(query.from_user.id, "demo_neg_second")
    kb = InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(text="☆", callback_data="rate:1"),
            InlineKeyboardButton(text="☆", callback_data="rate:2"),
            InlineKeyboardButton(text="☆", callback_data="rate:3"),
            InlineKeyboardButton(text="☆", callback_data="rate:4"),
            InlineKeyboardButton(text="☆", callback_data="rate:5"),
        ]]
    )
    await query.message.answer(
        "🧪 <i>Демо-режим — негатив</i>\n\n"
        "<b>Оцените услугу (недовольный клиент):</b>",
        parse_mode="HTML",
        reply_markup=kb,
    )


@router.message(F.photo)
async def on_photo(message: Message) -> None:
    bot = message.bot
    uid = message.from_user.id
    s = get_session(uid)
    if s["step"] != "demo_wait_screenshot":
        return
    activity_log.log_event(uid, "screenshot_sent", username=message.from_user.username)
    viewer = get_viewer_chat_id() or (config.ADMIN_IDS[0] if config.ADMIN_IDS else None)
    if not viewer:
        logger.warning("Скрин от %s, но нет получателя (ADMIN_IDS / ADMIN_GROUP_CHAT_ID пуст)", uid)
        await message.answer(
            "⏳ Скрин получен. Ожидайте проверки модератором.",
            parse_mode="HTML",
        )
        await after_positive_done(bot, uid, message.chat.id)
        return

    ds = _get_demo_salon(uid)
    salon_name = escape_html(ds.get("name", "—"))
    address = escape_html(ds.get("other", "").replace("адрес: ", ""))
    ry = ds.get("ratingYandex")
    r2 = ds.get("rating2gis")
    ny = ds.get("reviewsYandex")
    n2 = ds.get("reviews2gis")
    metrics_parts = []
    if ry is not None or ny is not None:
        metrics_parts.append(f"Яндекс: ⭐ {_v(ry)} ({_plural(_v(ny, 0), 'отзыв', 'отзыва', 'отзывов')})")
    if r2 is not None or n2 is not None:
        metrics_parts.append(f"2ГИС: ⭐ {_v(r2)} ({_plural(_v(n2, 0), 'отзыв', 'отзыва', 'отзывов')})")

    sid = secrets.token_hex(6)
    pending_screens[sid] = {
        "userId": uid,
        "chatId": message.chat.id,
    }
    photos = message.photo
    file_id = photos[-1].file_id
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="✅ Одобрить", callback_data=f"scr:{sid}:ok"),
                InlineKeyboardButton(text="❌ Отклонить", callback_data=f"scr:{sid}:no"),
            ]
        ]
    )
    cap = (
        "📸 <b>Скрин на проверке</b>\n"
        f'<a href="tg://user?id={uid}">открыть диалог</a>\n\n'
        f"Салон: <b>«{salon_name}»</b>\n"
    )
    if address:
        cap += f"📍 {address}\n"
    if metrics_parts:
        cap += "📊 " + " | ".join(metrics_parts) + "\n"
    await bot.send_photo(
        viewer,
        file_id,
        caption=cap,
        parse_mode="HTML",
        reply_markup=kb,
    )
    await message.answer(
        "⏳ Скрин получен. Администратор проверит и подтвердит выдачу скидки.\n\n"
        "<i>В реальности вы получаете уведомление в Telegram и жмёте одну кнопку, да или нет, чтобы подтвердить или отклонить скрин.</i>",
        parse_mode="HTML",
    )


@router.callback_query(F.data.startswith("scr:"))
async def cb_screen_moderate(query: CallbackQuery) -> None:
    bot = query.bot
    if not is_admin(query.from_user.id):
        await query.answer(text="Нет доступа", show_alert=True)
        return
    parts = query.data.split(":")
    if len(parts) != 3 or parts[0] != "scr":
        await query.answer()
        return
    await query.answer()
    sid = parts[1]
    ok = parts[2] == "ok"
    p = pending_screens.pop(sid, None)
    if not p:
        cap = (query.message.caption or "") + "\n\n<i>Устарело</i>"
        await query.message.edit_caption(caption=cap, parse_mode="HTML")
        return

    uid = p["userId"]
    chat_id = p["chatId"]
    activity_log.log_event(uid, "screenshot_approved" if ok else "screenshot_rejected")
    try:
        if ok:
            await bot.send_message(
                chat_id,
                "✅ Скрин подтверждён!\nВаш промокод на скидку 10%: "
                f"<b>{config.PROMO_CODE}</b>\n\n"
                "<i>В бою промокод можно генерировать автоматически.</i>",
                parse_mode="HTML",
            )
        else:
            set_step(uid, "demo_wait_screenshot")
            reject_kb = InlineKeyboardMarkup(
                inline_keyboard=[
                    [InlineKeyboardButton(text="📎 Отправить другой скрин", callback_data="ready_screen")],
                    [InlineKeyboardButton(text="Продолжить демо ➡️", callback_data="skip_screen_resubmit")],
                ]
            )
            await bot.send_message(
                chat_id,
                "Скрин не прошёл проверку.\n\n"
                "<i>В реальности клиент может отправить новый скриншот — "
                "администратор увидит его повторно на модерации.</i>",
                parse_mode="HTML",
                reply_markup=reject_kb,
            )
    except Exception as e:
        logger.exception(e)

    prev = query.message.caption or ""
    await query.message.edit_caption(
        caption=prev + f"\n\n<b>{'Одобрено' if ok else 'Отклонено'}</b> админом",
        parse_mode="HTML",
    )
    if ok:
        await after_positive_done(bot, uid, chat_id)


@router.message(DemoNegativeTextFilter(), F.text)
async def on_neg_text(message: Message) -> None:
    bot = message.bot
    if message.text and message.text.startswith("/"):
        return
    uid = message.from_user.id
    t = (message.text or "").strip()
    activity_log.log_event(uid, "negative_text", username=message.from_user.username, detail=t[:120])
    prev_step = get_session(uid)["step"]
    viewer = get_viewer_chat_id()
    if viewer:
        await bot.send_message(
            viewer,
            "🚨 <b>Негативный отзыв (демо)</b>\n"
            f"От: @{escape_html(message.from_user.username or '—')}\n"
            f"Текст: {escape_html(t)}\n"
            f'Диалог: <a href="tg://user?id={uid}">открыть диалог</a>',
            parse_mode="HTML",
        )
    s = get_session(uid)
    s["done_negative"] = True
    set_step(uid, "after_negative")
    await message.answer(
        "Спасибо за отзыв! Руководитель салона свяжется с вами, чтобы разобраться в ситуации.\n\n"
        "<i>В реальности вы получите такое уведомление сразу, что даёт возможность связаться "
        "с вашим клиентом и отработать негатив до того, как он в сердцах откроет "
        "Яндекс.Карты или 2ГИС, чтобы оставить там свой отзыв.</i>",
        parse_mode="HTML",
        reply_markup=ReplyKeyboardRemove(),
    )
    if s.get("done_positive"):
        await send_stats_and_sales(message, uid)
    else:
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="Да, позитивный сценарий", callback_data="demo_positive_from_neg")],
                [InlineKeyboardButton(text="Нет, к статистике", callback_data="skip_to_stats")],
            ]
        )
        await message.answer(
            "Хотите пройти <b>позитивный сценарий</b> (отзыв и скидка)?",
            parse_mode="HTML",
            reply_markup=kb,
        )


@router.callback_query(F.data == "demo_positive_from_neg")
async def cb_pos_from_neg(query: CallbackQuery) -> None:
    await query.answer()
    uid = query.from_user.id
    set_step(uid, "demo_positive")
    ds = _get_demo_salon(uid)
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Яндекс.Карты", url=ds["urlYandexReviews"])],
            [InlineKeyboardButton(text="2ГИС", url=ds["url2gisReviews"])],
            [InlineKeyboardButton(text="Готов отправить скрин", callback_data="ready_screen")],
        ]
    )
    await query.message.answer(
        "🧪 <i>Демо-режим — позитив</i>\n\n"
        f"Оставьте <b>один</b> отзыв или на Яндекс.Картах, или в 2 ГИС  о <b>«{escape_html(ds.get('name', 'салон'))}»</b> по ссылкам и пришлите скрин в чат.",
        parse_mode="HTML",
        reply_markup=kb,
    )


@router.callback_query(F.data == "skip_to_stats")
async def cb_skip_stats(query: CallbackQuery) -> None:
    await query.answer()
    await send_stats_and_sales(query.message, query.from_user.id)


@router.callback_query(F.data.startswith("roi:"))
async def cb_roi(query: CallbackQuery) -> None:
    await query.answer()
    key = query.data.split(":")[1]
    clients = "50–150"
    if key == "50":
        clients = "до 50"
    elif key == "more":
        clients = "более 150"
    extra = 8 if key == "50" else 22 if key == "150" else 45
    await query.message.edit_text(
        "💰 <b>Оценка эффекта (демо)</b>\n\n"
        f"Поток: <b>{escape_html(clients)}</b> клиентов в месяц.\n"
        f"Если около 30% ставят «5», и половина из них оставляет отзыв — это примерно <b>+{_plural(extra, 'отзыв', 'отзыва', 'отзывов')}</b> в месяц к карточке.\n\n"
        "Сильная карточка на картах даёт больше просмотров в поиске по району — без доп. бюджета на клики.\n\n"
        "Ниже — готовые пакеты под салон.",
        parse_mode="HTML",
    )
    await send_packages_block(query.message)


@router.callback_query(F.data.startswith("pkg:"))
async def cb_pkg(query: CallbackQuery) -> None:
    await query.answer()
    k = query.data.split(":")[1]
    payment = (
        "\n\n💳 Предоплата 50% через ЮMoney.\n"
        "Ссылку на оплату получите по email, после оплаты — квитанция. Всё официально.\n"
        "Оставшиеся 50% — после запуска бота.\n"
        "Аренда сервера — 500 ₽/мес."
    )
    if k == "start":
        text = (
            "🔹 <b>Старт</b> — 10 000 ₽\n\n"
            "• Сбор отзывов (Яндекс + 2ГИС)\n"
            "• Ручная модерация скринов\n"
            "• Уведомления в Telegram"
        )
    elif k == "biz":
        text = (
            "🔸 <b>Бизнес</b> — 15 000 ₽\n\n"
            "• Всё из «Старт»\n"
            "• Генерация уникальных промокодов на каждого клиента (а не один общий)\n"
            "• Запись выданной скидки в Яндекс.Документы (Excel) или CRM — "
            "администратор на стойке проверяет промокод при визите и отмечает как использованный\n\n"
            "📋 <b>Реестр:</b> клиент | дата | промокод | статус (выдан / использован)\n\n"
            "Без этого салон не может контролировать, кто реально пришёл по скидке, а кто нет."
        )
    else:
        text = (
            "🛡 <b>Безопасность</b> — +5 000 ₽ к пакету\n\n"
            "• <b>Реестр жалоб</b> — все негативы собираются в таблицу, "
            "а не просто сообщением в чат, которое потеряется в потоке\n"
            "• <b>Уведомление старшему мастеру</b> — потребуется настройка: "
            "кто «старший мастер», возможно несколько мастеров для разных филиалов\n"
            "• <b>Повторные напоминания</b> — если жалоба не отработана в срок"
        )
    await query.message.answer(
        text + payment + "\n\nНапишите, если нужно изменить этот сценарий под ваш  рабочий процесс.",
        parse_mode="HTML",
    )
    await send_cta_block(query.message)


@router.callback_query(F.data.startswith("cta:"))
async def cb_cta(query: CallbackQuery) -> None:
    await query.answer()
    kind = query.data.split(":")[1]
    action = "cta_audit" if kind == "audit" else "cta_setup"
    u = query.from_user
    activity_log.log_event(u.id, action, username=u.username, first_name=u.first_name)
    append_application(
        config.APPLICATIONS_JSON,
        {
            "userId": u.id,
            "username": u.username,
            "kind": "audit" if kind == "audit" else "setup",
        },
    )
    await query.message.answer(
        "Заявка принята. Я свяжусь с вами в Telegram для согласования времени.\n\n"
        "Спасибо за интерес!",
        parse_mode="HTML",
    )
    set_step(query.from_user.id, "idle")


@router.message(F.contact)
async def on_contact(message: Message) -> None:
    u = message.from_user
    activity_log.log_event(u.id, "phone_shared", username=u.username, first_name=u.first_name)
    c = message.contact
    append_application(
        config.APPLICATIONS_JSON,
        {
            "userId": message.from_user.id,
            "phone": c.phone_number,
            "kind": "phone",
        },
    )
    await message.answer(
        "Телефон получен. Перезвоню / напишу в удобное время.",
        parse_mode="HTML",
        reply_markup=ReplyKeyboardRemove(),
    )


@router.message(Command("send_promo"))
async def cmd_send_promo(message: Message) -> None:
    bot = message.bot
    if not is_admin(message.from_user.id):
        await message.answer("Команда только для администраторов.")
        return
    parts = (message.text or "").split()
    force_all = "--all" in parts
    try:
        data = load_leads(config.LEADS_JSON)
    except Exception:
        await message.answer("Не удалось прочитать leads.json")
        return

    leads = [
        l
        for l in data["leads"]
        if l.get("telegram_chat_id") and (force_all or not l.get("sent"))
    ]
    if not leads:
        await message.answer("Нет лидов для отправки (проверьте telegram_chat_id и sent).")
        return

    await message.answer(f"Рассылка: {len(leads)} адресатов. Парсинг перед каждым…")

    for lead in leads:
        idx = data["leads"].index(lead)
        try:
            metrics = await fetch_salon_metrics_fresh(
                url2gis=lead.get("url2gis"),
                urlYandex=lead.get("urlYandex"),
                name=lead.get("salon_name"),
                skipYandex=not (lead.get("urlYandex") or lead.get("salon_name")),
            )
            text = build_promo_message(
                metrics,
                lead.get("owner_name"),
                lead.get("salon_name"),
            )
            kb = InlineKeyboardMarkup(
                inline_keyboard=[
                    [InlineKeyboardButton(text="🚀 Запустить демо", callback_data="start_demo")]
                ]
            )
            await bot.send_message(
                lead["telegram_chat_id"],
                text,
                parse_mode="HTML",
                reply_markup=kb,
            )
            lead["sent"] = True
            lead["sent_at"] = datetime.now(timezone.utc).isoformat()
            lead["last_metrics_at"] = metrics.get("parsedAt")
            if idx >= 0:
                data["leads"][idx] = lead
            save_leads(config.LEADS_JSON, data)
        except Exception as e:
            logger.exception(e)
            await message.answer(f"Ошибка для «{lead.get('salon_name', '?')}»: {e}")
        await asyncio.sleep(config.BROADCAST_PAUSE_SEC)

    await message.answer("Готово.")


async def _daily_reminder(bot: Bot) -> None:
    MSK = timezone(timedelta(hours=3))
    TARGET_HOUR = 6

    while True:
        now_msk = datetime.now(MSK)
        next_run = now_msk.replace(hour=TARGET_HOUR, minute=0, second=0, microsecond=0)
        if next_run <= now_msk:
            next_run += timedelta(days=1)
        wait_sec = (next_run - now_msk).total_seconds()
        logger.info("Reminder: next fire in %.0f sec (%s MSK)", wait_sec, next_run.strftime("%Y-%m-%d %H:%M"))
        await asyncio.sleep(wait_sec)

        if not config.ADMIN_IDS:
            continue
        admin_id = config.ADMIN_IDS[0]

        setup_leads = activity_log.has_action("cta_setup")
        users = activity_log.get_all_users()
        total = len(users)
        demos = sum(
            1 for u in users.values()
            if any(e["action"] == "demo_started" for e in u.get("events", []))
        )

        if setup_leads:
            names = ", ".join(
                f"@{u.get('username', '?')}" for _, u in setup_leads
            )
            text = (
                f"6:00 МСК — есть заявка на настройку от {names}!\n"
                "Подробности: /adm"
            )
        else:
            text = (
                "6:00 МСК — напоминание.\n"
                "Заявок на настройку пока нет.\n"
                f"Лидов в трекере: {total} (из них прошли демо: {demos}).\n"
                "Запустите /send_promo для следующей рассылки."
            )
        try:
            await bot.send_message(admin_id, text)
        except Exception as e:
            logger.exception("Reminder send failed: %s", e)


async def main() -> None:
    global _hot_salons
    _hot_salons = _load_hot_salons()
    activity_log.init(config.ACTIVITY_LOG_JSON)
    if not config.BOT_TOKEN:
        print("Задайте BOT_TOKEN в .env", file=sys.stderr)
        sys.exit(1)
    try:
        session = AiohttpSession(proxy=config.HTTPS_PROXY) if config.HTTPS_PROXY else None
    except RuntimeError as exc:
        if config.HTTPS_PROXY:
            print(
                "Для работы HTTPS_PROXY установите зависимость aiohttp-socks:\n"
                "  .\\.venv\\Scripts\\python.exe -m pip install aiohttp-socks\n"
                f"Текущая ошибка: {exc}",
                file=sys.stderr,
            )
            sys.exit(1)
        raise
    bot = Bot(token=config.BOT_TOKEN, session=session)
    dp = Dispatcher()
    dp.include_router(router)
    asyncio.create_task(_daily_reminder(bot))
    logger.info("Бот запущен (Python)")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
