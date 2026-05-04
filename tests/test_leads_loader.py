"""Тесты для bot.leads_store (JSON лиды без сети)."""

import json
from pathlib import Path

from bot.leads_store import load_leads, read_json_safe, save_leads, write_json_atomic


def test_read_json_safe_missing_file_returns_fallback(tmp_path: Path) -> None:
    p = tmp_path / "nope.json"
    fb = {"leads": [{"x": 1}]}
    assert read_json_safe(p, fb) == fb


def test_read_json_safe_invalid_json_returns_fallback(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text("not json {", encoding="utf8")
    fb = {"leads": []}
    assert read_json_safe(p, fb) == fb


def test_load_leads_normalizes_non_list_leads(tmp_path: Path) -> None:
    p = tmp_path / "leads.json"
    p.write_text('{"leads": "broken"}', encoding="utf8")
    data = load_leads(p)
    assert data["leads"] == []


def test_save_leads_roundtrip(tmp_path: Path) -> None:
    p = tmp_path / "leads.json"
    payload = {"leads": [{"telegram_chat_id": 1, "sent": False}]}
    save_leads(p, payload)
    assert load_leads(p) == payload


def test_write_json_atomic_creates_parent_dirs(tmp_path: Path) -> None:
    p = tmp_path / "nested" / "a.json"
    write_json_atomic(p, {"k": 1})
    assert p.exists()
    assert json.loads(p.read_text(encoding="utf8")) == {"k": 1}
