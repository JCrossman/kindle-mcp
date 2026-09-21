"""Paths and settings. Everything is overridable by environment variable."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    home: Path
    db_path: Path
    browser_profile: Path
    notebook_base: str
    obsidian_vault: Path | None
    obsidian_folder: str
    request_delay_s: float

    @classmethod
    def load(cls) -> "Config":
        home = Path(os.environ.get("KINDLE_MCP_HOME", Path.home() / ".kindle-mcp")).expanduser()
        vault = os.environ.get("OBSIDIAN_VAULT")
        return cls(
            home=home,
            db_path=Path(os.environ.get("KINDLE_MCP_DB", home / "kindle.db")).expanduser(),
            browser_profile=home / "browser-profile",
            notebook_base=os.environ.get("KINDLE_NOTEBOOK_BASE", "https://read.amazon.com").rstrip("/"),
            obsidian_vault=Path(vault).expanduser() if vault else None,
            obsidian_folder=os.environ.get("OBSIDIAN_FOLDER", "Kindle"),
            request_delay_s=float(os.environ.get("KINDLE_REQUEST_DELAY", "1.5")),
        )

    def ensure_dirs(self) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        self.browser_profile.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
