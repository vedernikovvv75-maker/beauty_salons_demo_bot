"""Свежие метрики карточек: вызов Node `fetch_metrics.cjs` (Playwright)."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from typing import Any

from .config import NODE_SCRIPTS_DIR


def _fetch_sync(
    url2gis: str | None = None,
    url_yandex: str | None = None,
    name: str | None = None,
    skip_yandex: bool = False,
) -> dict[str, Any]:
    """Синхронно запускает node fetch_metrics.cjs и парсит JSON stdout.

    Args:
        url2gis: URL карточки в 2ГИС.
        url_yandex: URL карточки в Яндекс.Картах.
        name: Поиск по имени (если без прямых URL).
        skip_yandex: Не трогать Яндекс (передаётся в Node).

    Returns:
        Словарь метрик (рейтинги, число отзывов, служебные поля от скрипта).

    Raises:
        FileNotFoundError: Нет `fetch_metrics.cjs` или не установлен node_modules.
        RuntimeError: Ненулевой код выхода Node или невалидный JSON в stdout.
    """
    script = NODE_SCRIPTS_DIR / "fetch_metrics.cjs"
    if not script.exists():
        raise FileNotFoundError(
            f"Нет {script}. Установите зависимости: cd node_scripts && npm install"
        )
    payload = {
        "url2gis": url2gis or "",
        "urlYandex": url_yandex or "",
        "name": name or "",
        "skipYandex": skip_yandex,
    }
    arg = json.dumps(payload, ensure_ascii=False)
    proc = subprocess.run(
        ["node", str(script), arg],
        cwd=str(NODE_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        timeout=300,
        env=os.environ.copy(),
        encoding="utf8",
    )
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        raise RuntimeError(err or out or "node fetch_metrics failed")
    try:
        return json.loads(out)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Некорректный JSON от node: {out[:500]}") from e


async def fetch_salon_metrics_fresh(
    *,
    url2gis: str | None = None,
    urlYandex: str | None = None,
    name: str | None = None,
    skipYandex: bool = False,
) -> dict[str, Any]:
    """То же, что :func:`_fetch_sync`, но без блокировки event loop (thread pool).

    Сигнатура совпадает с `_fetch_sync`; исключения те же.
    """
    return await asyncio.to_thread(
        _fetch_sync,
        url2gis,
        urlYandex,
        name,
        skipYandex,
    )
