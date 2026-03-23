import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def read_json_safe(file_path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        if not file_path.exists():
            return fallback
        return json.loads(file_path.read_text(encoding="utf8"))
    except Exception:
        return fallback


def write_json_atomic(file_path: Path, data: dict[str, Any]) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = file_path.with_suffix(file_path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf8")
    tmp.replace(file_path)


def load_leads(file_path: Path) -> dict[str, Any]:
    data = read_json_safe(file_path, {"leads": []})
    if not isinstance(data.get("leads"), list):
        data["leads"] = []
    return data


def save_leads(file_path: Path, data: dict[str, Any]) -> None:
    write_json_atomic(file_path, data)


def append_application(file_path: Path, row: dict[str, Any]) -> None:
    data = read_json_safe(file_path, {"applications": []})
    if not isinstance(data.get("applications"), list):
        data["applications"] = []
    data["applications"].append(
        {**row, "createdAt": datetime.now(timezone.utc).isoformat()}
    )
    write_json_atomic(file_path, data)
