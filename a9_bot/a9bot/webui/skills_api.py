"""Skills API for WebUI — list available skills and their metadata."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from a9bot.agent.skills import SkillsLoader
from a9bot.webui.settings_api import WebUISettingsError


def list_skills(workspace_path: Path) -> list[dict[str, Any]]:
    """Return a list of available skills with name, title, emoji, description."""
    loader = SkillsLoader(workspace_path)
    results: list[dict[str, Any]] = []
    for entry in loader.list_skills(filter_unavailable=False):
        meta = loader.get_skill_metadata(entry["name"]) or {}
        metadata_raw = meta.get("metadata", {})
        a9bot_meta = metadata_raw.get("a9bot", {}) if isinstance(metadata_raw, dict) else {}
        results.append({
            "name": entry["name"],
            "title": meta.get("name", entry["name"]),
            "emoji": a9bot_meta.get("emoji", "🧠"),
            "description": meta.get("description", ""),
            "source": entry["source"],
        })
    return results


def create_skill(workspace_path: Path, name: str, content: str) -> dict[str, Any]:
    """Create a new skill with the given name and SKILL.md content."""
    import re
    if not re.match(r"^[a-zA-Z0-9_-]+$", name):
        raise WebUISettingsError("Skill name must contain only letters, numbers, hyphens, and underscores.")
    skills_dir = workspace_path / "skills" / name
    if skills_dir.exists():
        raise WebUISettingsError(f"Skill '{name}' already exists.")
    skills_dir.mkdir(parents=True, exist_ok=True)
    skill_file = skills_dir / "SKILL.md"
    skill_file.write_text(content, encoding="utf-8")
    return {"success": True, "name": name}
