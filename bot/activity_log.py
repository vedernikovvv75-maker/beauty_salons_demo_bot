"""Persistent per-user activity log backed by a JSON file."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .leads_store import read_json_safe, write_json_atomic

_EMPTY: dict[str, Any] = {"users": {}}

_file_path: Path | None = None


def init(path: Path) -> None:
    global _file_path
    _file_path = path


def _load() -> dict[str, Any]:
    if _file_path is None:
        return {"users": {}}
    data = read_json_safe(_file_path, _EMPTY)
    if not isinstance(data.get("users"), dict):
        data["users"] = {}
    return data


def _save(data: dict[str, Any]) -> None:
    if _file_path is not None:
        write_json_atomic(_file_path, data)


def log_event(
    uid: int,
    action: str,
    *,
    username: str | None = None,
    first_name: str | None = None,
    detail: str | None = None,
) -> None:
    data = _load()
    key = str(uid)
    if key not in data["users"]:
        data["users"][key] = {"username": username, "first_name": first_name, "events": []}
    user = data["users"][key]
    if username:
        user["username"] = username
    if first_name:
        user["first_name"] = first_name
    entry: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "action": action,
    }
    if detail is not None:
        entry["detail"] = detail
    user["events"].append(entry)
    _save(data)


def get_all_users() -> dict[str, Any]:
    return _load().get("users", {})


def get_user_events(uid: int) -> list[dict[str, Any]]:
    return _load().get("users", {}).get(str(uid), {}).get("events", [])


def has_action(action: str) -> list[tuple[str, dict]]:
    """Return list of (uid_str, user_dict) where the user has the given action."""
    result = []
    for uid_str, u in get_all_users().items():
        if any(e["action"] == action for e in u.get("events", [])):
            result.append((uid_str, u))
    return result


def get_sent_salon_ids() -> set[str]:
    data = _load()
    return set(data.get("sent_salon_ids", []))


def mark_salon_sent(salon_id: str) -> None:
    data = _load()
    sent = set(data.get("sent_salon_ids", []))
    sent.add(salon_id)
    data["sent_salon_ids"] = sorted(sent)
    _save(data)
