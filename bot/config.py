from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT / ".env")

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_IDS = [
    int(x.strip())
    for x in (os.getenv("ADMIN_IDS") or "").split(",")
    if x.strip().isdigit()
]
_raw_admin_group = (os.getenv("ADMIN_GROUP_CHAT_ID") or "").strip()
ADMIN_GROUP_CHAT_ID: str | None = (
    _raw_admin_group if _raw_admin_group and _raw_admin_group.lstrip("-").isdigit() else None
)
HTTPS_PROXY = (os.getenv("HTTPS_PROXY") or os.getenv("https_proxy") or "").strip()

DEMO_OWNER_NAME = os.getenv("DEMO_OWNER_NAME", "коллега")
DEVELOPER_NAME = os.getenv("DEVELOPER_NAME", "Виталий")
DEMO_SALON_NAME = os.getenv("DEMO_SALON_NAME", "Демо-салон")
MAP_LINK_YANDEX = os.getenv("MAP_LINK_YANDEX", "https://yandex.ru/maps")
MAP_LINK_2GIS = os.getenv("MAP_LINK_2GIS", "https://2gis.ru")
PROMO_CODE = os.getenv("PROMO_CODE", "BEAUTY10")

LEADS_JSON = _ROOT / (os.getenv("LEADS_JSON") or "leads.json")
APPLICATIONS_JSON = _ROOT / (os.getenv("APPLICATIONS_JSON") or "applications.json")
ACTIVITY_LOG_JSON = _ROOT / (os.getenv("ACTIVITY_LOG_JSON") or "activity_log.json")
BROADCAST_PAUSE_SEC = float(os.getenv("BROADCAST_PAUSE_SEC", "0.75"))
AUTO_SERIES_PAUSE_SEC = float(os.getenv("AUTO_SERIES_PAUSE_SEC", "60"))

NODE_SCRIPTS_DIR = _ROOT / "node_scripts"
