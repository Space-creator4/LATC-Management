from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import urlencode

import aiohttp
import discord
from aiohttp import web
from discord import app_commands
from discord.ext import commands

BASE_DIR = Path(__file__).resolve().parent
ACCENT_COLOR = 0x1F6FEB
PENDING_COLOR = 0xF2C744
APPROVED_COLOR = 0x3BA55D
DENIED_COLOR = 0xED4245
UNVERIFIED_COLOR = 0x8B5CF6

ROBLOX_AUTHORIZE_URL = "https://apis.roblox.com/oauth/v1/authorize"
ROBLOX_TOKEN_URL = "https://apis.roblox.com/oauth/v1/token"
ROBLOX_USERINFO_URL = "https://apis.roblox.com/oauth/v1/userinfo"
ROBLOX_USER_API = "https://users.roblox.com/v1/users"
ROBLOX_USERNAME_API = "https://users.roblox.com/v1/usernames/users"
ROBLOX_USERNAME_SEARCH_API = "https://apis.roblox.com/user-search-api/v1/usernames/search"
ROBLOX_LINK_TTL_SECONDS = 900
ROBLOX_CALLBACK_PATH = "/roblox/callback"
ROBLOX_BIO_EDIT_URL = "https://www.roblox.com/my/account#!/about"
USER_AGENT = "LATC-Discord-Bot/1.0"
VERIFY_CODE_PREFIX = "VERIFY"

log = logging.getLogger("latc")


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env_int(name: str) -> int | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        log.warning("Environment variable %s is not a valid integer: %r", name, raw)
        return None


def env_id_set(name: str) -> frozenset[int]:
    values: set[int] = set()
    for chunk in os.environ.get(name, "").replace(";", ",").split(","):
        chunk = chunk.strip()
        if chunk.isdigit():
            values.add(int(chunk))
    return frozenset(values)


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    log.warning("Environment variable %s is not a valid boolean: %r", name, raw)
    return default


def truncate(text: str, limit: int = 200) -> str:
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def now_ts() -> int:
    return int(time.time())


def canonicalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


@dataclass(frozen=True)
class Config:
    token: str
    database_path: Path
    guild_id: int | None
    panel_channel_id: int | None
    review_channel_id: int | None
    modlog_channel_id: int | None
    staff_role_id: int | None
    pilot_role_id: int | None
    atc_role_id: int | None
    owner_ids: frozenset[int]
    roblox_client_id: int | None
    roblox_client_secret: str | None
    roblox_redirect_uri: str | None
    roblox_callback_port: int
    roblox_scopes: str
    verification_role_id: int | None
    code_expiry_minutes: int
    max_verify_attempts: int
    verify_cooldown_seconds: int
    allow_roblox_transfer: bool
    remove_role_on_unlink: bool
    roblox_lookup_min_interval: float

    @classmethod
    def from_env(cls) -> "Config":
        token = os.environ.get("DISCORD_TOKEN", "").strip()
        if not token:
            raise RuntimeError("DISCORD_TOKEN is not set. Add it to .env or the GitHub secret.")
        redirect_uri = os.environ.get("ROBLOX_REDIRECT_URI", "").strip() or None
        port = env_int("ROBLOX_CALLBACK_PORT") or 8787
        scopes = os.environ.get("ROBLOX_SCOPES", "openid profile").strip() or "openid profile"
        return cls(
            token=token,
            database_path=Path(os.environ.get("DB_PATH", BASE_DIR / "data" / "latc.db")),
            guild_id=env_int("GUILD_ID"),
            panel_channel_id=env_int("APPLICATION_PANEL_CHANNEL_ID"),
            review_channel_id=env_int("APPLICATION_REVIEW_CHANNEL_ID"),
            modlog_channel_id=env_int("MODLOG_CHANNEL_ID"),
            staff_role_id=env_int("STAFF_ROLE_ID"),
            pilot_role_id=env_int("PILOT_ROLE_ID"),
            atc_role_id=env_int("ATC_ROLE_ID"),
            owner_ids=env_id_set("OWNER_IDS"),
            roblox_client_id=env_int("ROBLOX_CLIENT_ID"),
            roblox_client_secret=os.environ.get("ROBLOX_CLIENT_SECRET", "").strip() or None,
            roblox_redirect_uri=redirect_uri,
            roblox_callback_port=port,
            roblox_scopes=scopes,
            verification_role_id=env_int("VERIFICATION_ROLE_ID"),
            code_expiry_minutes=max(env_int("VERIFY_CODE_EXPIRY_MINUTES") or 10, 1),
            max_verify_attempts=max(env_int("VERIFY_MAX_ATTEMPTS") or 5, 1),
            verify_cooldown_seconds=max(env_int("VERIFY_COOLDOWN_SECONDS") or 30, 0),
            allow_roblox_transfer=env_flag("VERIFY_ALLOW_TRANSFER", False),
            remove_role_on_unlink=env_flag("VERIFY_REMOVE_ROLE_ON_UNLINK", True),
            roblox_lookup_min_interval=max(
                float(os.environ.get("ROBLOX_LOOKUP_MIN_INTERVAL", "0.6") or 0.6), 0.0
            ),
        )

    @property
    def roblox_oauth_ready(self) -> bool:
        return bool(self.roblox_client_id and self.roblox_client_secret and self.roblox_redirect_uri)

    def role_for_kind(self, kind: str) -> int | None:
        return self.pilot_role_id if kind == "pilot" else self.atc_role_id


SCHEMA = """
CREATE TABLE IF NOT EXISTS automod_config (
    guild_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    block_invites INTEGER NOT NULL DEFAULT 1,
    block_links INTEGER NOT NULL DEFAULT 0,
    max_mentions INTEGER NOT NULL DEFAULT 5,
    max_caps_ratio REAL NOT NULL DEFAULT 0.70,
    min_caps_length INTEGER NOT NULL DEFAULT 12,
    max_newlines INTEGER NOT NULL DEFAULT 12,
    on_violation TEXT NOT NULL DEFAULT 'delete',
    strike_action TEXT NOT NULL DEFAULT 'timeout',
    strike_limit INTEGER NOT NULL DEFAULT 3,
    strike_window_days INTEGER NOT NULL DEFAULT 7,
    timeout_seconds INTEGER NOT NULL DEFAULT 600,
    panel_message_id INTEGER
);

CREATE TABLE IF NOT EXISTS automod_words (
    guild_id INTEGER NOT NULL,
    word TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, word)
);

CREATE TABLE IF NOT EXISTS automod_ignores (
    guild_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, target_id)
);

CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    moderator_id INTEGER,
    reason TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'automod',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS warnings_lookup ON warnings (guild_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    answers TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    review_note TEXT,
    reviewer_id INTEGER,
    channel_id INTEGER,
    message_id INTEGER,
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER
);

CREATE INDEX IF NOT EXISTS applications_lookup ON applications (guild_id, status);

CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id INTEGER PRIMARY KEY,
    roblox_requirement TEXT NOT NULL DEFAULT 'off',
    roblox_bio_rule TEXT NOT NULL DEFAULT 'off',
    roblox_min_account_age_days INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS roblox_links (
    state TEXT PRIMARY KEY,
    guild_id INTEGER NOT NULL,
    discord_user_id INTEGER NOT NULL,
    code_verifier TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roblox_bio_codes (
    guild_id INTEGER NOT NULL,
    discord_user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS verify_sessions (
    guild_id INTEGER NOT NULL,
    discord_user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    username TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,
    PRIMARY KEY (guild_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS roblox_accounts (
    guild_id INTEGER NOT NULL,
    discord_user_id INTEGER NOT NULL,
    roblox_user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT,
    bio TEXT NOT NULL DEFAULT '',
    bio_ok INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL,
    account_age_days INTEGER,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verified_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS verify_settings (
    guild_id INTEGER PRIMARY KEY,
    role_id INTEGER,
    code_expiry_minutes INTEGER NOT NULL DEFAULT 10,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    cooldown_seconds INTEGER NOT NULL DEFAULT 30,
    allow_transfer INTEGER NOT NULL DEFAULT 0,
    remove_role_on_unlink INTEGER NOT NULL DEFAULT 1
);
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.executescript(SCHEMA)
        self._rename_column("roblox_accounts", "roblox_username", "username")
        self._rename_column("roblox_accounts", "roblox_display_name", "display_name")
        self._add_column("roblox_accounts", "display_name", "TEXT")
        self._add_column("roblox_accounts", "bio", "TEXT NOT NULL DEFAULT ''")
        self._add_column("roblox_accounts", "bio_ok", "INTEGER NOT NULL DEFAULT 0")
        self._add_column("guild_settings", "roblox_bio_rule", "TEXT NOT NULL DEFAULT 'off'")
        self._enforce_roblox_link_uniqueness()
        self._connection.commit()

    def _enforce_roblox_link_uniqueness(self) -> None:
        """Guarantee one Roblox account maps to one Discord account per guild.

        Older databases were written before this constraint existed, so duplicates are
        collapsed first (newest verified row wins) and only then is the index created.
        """
        self._connection.execute(
            "DELETE FROM roblox_accounts WHERE rowid NOT IN ("
            " SELECT MAX(rowid) FROM roblox_accounts GROUP BY guild_id, roblox_user_id)"
        )
        self._connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS roblox_accounts_owner"
            " ON roblox_accounts (guild_id, roblox_user_id)"
        )

    def _add_column(self, table: str, column: str, definition: str) -> None:
        if column not in self._columns(table):
            self._connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def _rename_column(self, table: str, old: str, new: str) -> None:
        existing = self._columns(table)
        if old in existing and new not in existing:
            self._connection.execute(f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}")

    def _columns(self, table: str) -> set[str]:
        return {row["name"] for row in self._connection.execute(f"PRAGMA table_info({table})")}

    def _write(self, sql: str, params: Sequence[Any] = ()) -> int:
        with self._lock:
            cursor = self._connection.execute(sql, params)
            self._connection.commit()
            if sql.lstrip()[:6].upper() == "INSERT":
                return int(cursor.lastrowid or 0)
            return int(cursor.rowcount if cursor.rowcount > 0 else 0)

    def _rows(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._connection.execute(sql, params).fetchall())

    def _row(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._connection.execute(sql, params).fetchone()

    async def fetch_all(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        return await asyncio.to_thread(self._rows, sql, params)

    async def fetch_one(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        return await asyncio.to_thread(self._row, sql, params)

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        return await asyncio.to_thread(self._write, sql, params)

    async def get_automod(self, guild_id: int) -> "AutomodConfig":
        row = await self.fetch_one("SELECT * FROM automod_config WHERE guild_id = ?", (guild_id,))
        words = {
            item["word"]
            for item in await self.fetch_all(
                "SELECT word FROM automod_words WHERE guild_id = ?", (guild_id,)
            )
        }
        ignores: dict[str, set[int]] = {"channel": set(), "role": set()}
        for entry in await self.fetch_all(
            "SELECT kind, target_id FROM automod_ignores WHERE guild_id = ?", (guild_id,)
        ):
            ignores.setdefault(entry["kind"], set()).add(int(entry["target_id"]))
        if row is None:
            return AutomodConfig(
                blocked_words=words,
                ignored_channels=ignores["channel"],
                ignored_roles=ignores["role"],
            )
        return AutomodConfig(
            enabled=bool(row["enabled"]),
            blocked_words=words,
            ignored_channels=ignores["channel"],
            ignored_roles=ignores["role"],
            block_invites=bool(row["block_invites"]),
            block_links=bool(row["block_links"]),
            max_mentions=int(row["max_mentions"]),
            max_caps_ratio=float(row["max_caps_ratio"]),
            min_caps_length=int(row["min_caps_length"]),
            max_newlines=int(row["max_newlines"]),
            on_violation=str(row["on_violation"]),
            strike_action=str(row["strike_action"]),
            strike_limit=int(row["strike_limit"]),
            strike_window_days=int(row["strike_window_days"]),
            timeout_seconds=int(row["timeout_seconds"]),
        )

    async def set_automod(self, guild_id: int, **values: Any) -> None:
        allowed = {
            "enabled",
            "block_invites",
            "block_links",
            "max_mentions",
            "max_caps_ratio",
            "min_caps_length",
            "max_newlines",
            "on_violation",
            "strike_action",
            "strike_limit",
            "strike_window_days",
            "timeout_seconds",
        }
        fields = {key: value for key, value in values.items() if key in allowed}
        if not fields:
            return
        await self.execute("INSERT OR IGNORE INTO automod_config (guild_id) VALUES (?)", (guild_id,))
        assignments = ", ".join(f"{key} = ?" for key in fields)
        await self.execute(
            f"UPDATE automod_config SET {assignments} WHERE guild_id = ?",
            [*fields.values(), guild_id],
        )

    async def add_blocked_word(self, guild_id: int, word: str) -> None:
        await self.execute(
            "INSERT OR IGNORE INTO automod_words (guild_id, word, created_at) VALUES (?, ?, ?)",
            (guild_id, word, now_ts()),
        )

    async def remove_blocked_word(self, guild_id: int, word: str) -> int:
        return await self.execute(
            "DELETE FROM automod_words WHERE guild_id = ? AND word = ?", (guild_id, word)
        )

    async def clear_blocked_words(self, guild_id: int) -> int:
        return await self.execute("DELETE FROM automod_words WHERE guild_id = ?", (guild_id,))

    async def list_blocked_words(self, guild_id: int, limit: int = 60) -> list[str]:
        rows = await self.fetch_all(
            "SELECT word FROM automod_words WHERE guild_id = ? ORDER BY word LIMIT ?",
            (guild_id, limit),
        )
        return [str(row["word"]) for row in rows]

    async def set_ignore(self, guild_id: int, kind: str, target_id: int) -> None:
        await self.execute(
            "INSERT OR IGNORE INTO automod_ignores (guild_id, kind, target_id, created_at)"
            " VALUES (?, ?, ?, ?)",
            (guild_id, kind, target_id, now_ts()),
        )

    async def remove_ignore(self, guild_id: int, kind: str, target_id: int) -> int:
        return await self.execute(
            "DELETE FROM automod_ignores WHERE guild_id = ? AND kind = ? AND target_id = ?",
            (guild_id, kind, target_id),
        )

    async def add_warning(
        self,
        guild_id: int,
        user_id: int,
        moderator_id: int | None,
        reason: str,
        source: str = "automod",
    ) -> int:
        await self.execute(
            "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, source, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (guild_id, user_id, moderator_id, truncate(reason, 300), source, now_ts()),
        )
        return await self.count_warnings(guild_id, user_id)

    async def count_warnings(self, guild_id: int, user_id: int, since: int = 0) -> int:
        row = await self.fetch_one(
            "SELECT COUNT(*) AS total FROM warnings"
            " WHERE guild_id = ? AND user_id = ? AND created_at >= ?",
            (guild_id, user_id, since),
        )
        return int(row["total"]) if row else 0

    async def list_warnings(
        self, guild_id: int, user_id: int, limit: int = 10
    ) -> list[sqlite3.Row]:
        return await self.fetch_all(
            "SELECT * FROM warnings WHERE guild_id = ? AND user_id = ?"
            " ORDER BY created_at DESC LIMIT ?",
            (guild_id, user_id, limit),
        )

    async def clear_warnings(self, guild_id: int, user_id: int) -> int:
        return await self.execute(
            "DELETE FROM warnings WHERE guild_id = ? AND user_id = ?", (guild_id, user_id)
        )

    async def create_application(
        self, guild_id: int, user_id: int, kind: str, answers: dict[str, str]
    ) -> int:
        return await self.execute(
            "INSERT INTO applications (guild_id, user_id, kind, answers, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (guild_id, user_id, kind, json.dumps(answers), now_ts()),
        )

    async def set_application_message(self, app_id: int, channel_id: int, message_id: int) -> None:
        await self.execute(
            "UPDATE applications SET channel_id = ?, message_id = ? WHERE id = ?",
            (channel_id, message_id, app_id),
        )

    async def set_application_status(
        self, app_id: int, status: str, reviewer_id: int | None, note: str | None = None
    ) -> None:
        await self.execute(
            "UPDATE applications SET status = ?, reviewer_id = ?, review_note = ?,"
            " reviewed_at = ? WHERE id = ?",
            (status, reviewer_id, note, now_ts(), app_id),
        )

    async def get_application(self, app_id: int) -> sqlite3.Row | None:
        return await self.fetch_one("SELECT * FROM applications WHERE id = ?", (app_id,))

    async def pending_for_user(self, guild_id: int, user_id: int) -> sqlite3.Row | None:
        return await self.fetch_one(
            "SELECT * FROM applications WHERE guild_id = ? AND user_id = ?"
            " AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
            (guild_id, user_id),
        )

    async def list_applications(
        self, guild_id: int, status: str | None = None, limit: int = 25
    ) -> list[sqlite3.Row]:
        if status:
            return await self.fetch_all(
                "SELECT * FROM applications WHERE guild_id = ? AND status = ?"
                " ORDER BY created_at DESC LIMIT ?",
                (guild_id, status, limit),
            )
        return await self.fetch_all(
            "SELECT * FROM applications WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?",
            (guild_id, limit),
        )

    async def get_panel_message_id(self, guild_id: int) -> int | None:
        row = await self.fetch_one(
            "SELECT panel_message_id FROM automod_config WHERE guild_id = ?", (guild_id,)
        )
        return int(row["panel_message_id"]) if row and row["panel_message_id"] else None

    async def set_panel_message_id(self, guild_id: int, message_id: int | None) -> None:
        await self.execute("INSERT OR IGNORE INTO automod_config (guild_id) VALUES (?)", (guild_id,))
        await self.execute(
            "UPDATE automod_config SET panel_message_id = ? WHERE guild_id = ?",
            (message_id, guild_id),
        )

    async def restorable_applications(self) -> list[sqlite3.Row]:
        return await self.fetch_all(
            "SELECT id, kind FROM applications WHERE status = 'pending' AND message_id IS NOT NULL"
        )

    async def get_guild_settings(self, guild_id: int) -> dict[str, Any]:
        await self.execute("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)", (guild_id,))
        row = await self.fetch_one("SELECT * FROM guild_settings WHERE guild_id = ?", (guild_id,))
        return {
            "roblox_requirement": str(row["roblox_requirement"]),
            "roblox_bio_rule": str(row["roblox_bio_rule"]),
            "roblox_min_account_age_days": int(row["roblox_min_account_age_days"]),
        }

    async def set_roblox_requirement(self, guild_id: int, requirement: str) -> None:
        await self.execute("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)", (guild_id,))
        await self.execute(
            "UPDATE guild_settings SET roblox_requirement = ? WHERE guild_id = ?",
            (requirement, guild_id),
        )

    async def set_roblox_bio_rule(self, guild_id: int, rule: str) -> None:
        await self.execute("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)", (guild_id,))
        await self.execute(
            "UPDATE guild_settings SET roblox_bio_rule = ? WHERE guild_id = ?",
            (rule, guild_id),
        )

    def generate_code(self) -> str:
        """Cryptographically random, human-typable code in the form VERIFY-7K4P9Q.

        6 characters from a 32 symbol alphabet (no 0/O or 1/I) gives 10^9-ish entropy
        while staying easy to retype from a phone into a Roblox bio box.
        """
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        body = "".join(secrets.choice(alphabet) for _ in range(6))
        return f"{VERIFY_CODE_PREFIX}-{body}"

    async def get_or_create_session(
        self, guild_id: int, discord_user_id: int, expiry_minutes: int
    ) -> sqlite3.Row:
        """Return the member's live code, minting a new one only when there is none.

        Codes are only regenerated once the previous one has expired or been consumed, so
        repeated `/verify` calls never invalidate a code the member is still typing.
        """
        row = await self.fetch_one(
            "SELECT * FROM verify_sessions WHERE guild_id = ? AND discord_user_id = ?",
            (guild_id, discord_user_id),
        )
        if row is not None and self.session_is_live(row, expiry_minutes):
            return row
        code = await self._unused_code(guild_id, discord_user_id)
        await self.execute(
            "INSERT OR REPLACE INTO verify_sessions"
            " (guild_id, discord_user_id, code, username, attempts, last_attempt_at,"
            "  created_at, consumed_at) VALUES (?, ?, ?, NULL, 0, 0, ?, NULL)",
            (guild_id, discord_user_id, code, now_ts()),
        )
        return await self.fetch_one(
            "SELECT * FROM verify_sessions WHERE guild_id = ? AND discord_user_id = ?",
            (guild_id, discord_user_id),
        )

    async def _unused_code(self, guild_id: int, discord_user_id: int) -> str:
        for _ in range(20):
            code = self.generate_code()
            clash = await self.fetch_one(
                "SELECT 1 FROM verify_sessions WHERE code = ? AND guild_id = ?"
                " AND discord_user_id != ? AND consumed_at IS NULL",
                (code, guild_id, discord_user_id),
            )
            if clash is None:
                return code
        return f"{VERIFY_CODE_PREFIX}-{secrets.token_hex(6).upper()}"

    @staticmethod
    def session_is_live(row: sqlite3.Row, expiry_minutes: int) -> bool:
        if row["consumed_at"] is not None:
            return False
        return now_ts() - int(row["created_at"]) < expiry_minutes * 60

    async def set_session_username(
        self, guild_id: int, discord_user_id: int, username: str
    ) -> None:
        await self.execute(
            "UPDATE verify_sessions SET username = ? WHERE guild_id = ? AND discord_user_id = ?",
            (username, guild_id, discord_user_id),
        )

    async def record_attempt(self, guild_id: int, discord_user_id: int) -> None:
        await self.execute(
            "UPDATE verify_sessions SET attempts = attempts + 1, last_attempt_at = ?"
            " WHERE guild_id = ? AND discord_user_id = ?",
            (now_ts(), guild_id, discord_user_id),
        )

    async def consume_session(self, guild_id: int, discord_user_id: int) -> None:
        await self.execute(
            "UPDATE verify_sessions SET consumed_at = ? WHERE guild_id = ? AND discord_user_id = ?",
            (now_ts(), guild_id, discord_user_id),
        )

    async def clear_session(self, guild_id: int, discord_user_id: int) -> None:
        await self.execute(
            "DELETE FROM verify_sessions WHERE guild_id = ? AND discord_user_id = ?",
            (guild_id, discord_user_id),
        )

    async def get_session(self, guild_id: int, discord_user_id: int) -> sqlite3.Row | None:
        return await self.fetch_one(
            "SELECT * FROM verify_sessions WHERE guild_id = ? AND discord_user_id = ?",
            (guild_id, discord_user_id),
        )

    async def delete_bio_code(self, guild_id: int, discord_user_id: int) -> int:
        return await self.execute(
            "DELETE FROM roblox_bio_codes WHERE guild_id = ? AND discord_user_id = ?",
            (guild_id, discord_user_id),
        )

    async def active_code(self, guild_id: int, discord_user_id: int) -> str | None:
        """Current code for the member, or None when there is no live session."""
        row = await self.get_session(guild_id, discord_user_id)
        return str(row["code"]) if row is not None and row["consumed_at"] is None else None

    async def get_verify_settings(self, guild_id: int, defaults: "Config") -> dict[str, Any]:
        await self.execute("INSERT OR IGNORE INTO verify_settings (guild_id) VALUES (?)", (guild_id,))
        row = await self.fetch_one(
            "SELECT * FROM verify_settings WHERE guild_id = ?", (guild_id,)
        )
        return {
            "role_id": int(row["role_id"]) if row["role_id"] else defaults.verification_role_id,
            "code_expiry_minutes": int(row["code_expiry_minutes"]) or defaults.code_expiry_minutes,
            "max_attempts": int(row["max_attempts"]) or defaults.max_verify_attempts,
            "cooldown_seconds": int(row["cooldown_seconds"]) or defaults.verify_cooldown_seconds,
            "allow_transfer": bool(row["allow_transfer"]),
            "remove_role_on_unlink": bool(row["remove_role_on_unlink"]),
        }

    async def set_verify_settings(self, guild_id: int, **values: Any) -> None:
        await self.get_verify_settings(guild_id, Config.__new__(Config))
        columns = {
            "role_id": int,
            "code_expiry_minutes": int,
            "max_attempts": int,
            "cooldown_seconds": int,
            "allow_transfer": int,
            "remove_role_on_unlink": int,
        }
        for key, raw in values.items():
            if raw is None or key not in columns:
                continue
            await self.execute(
                f"UPDATE verify_settings SET {key} = ? WHERE guild_id = ?",
                (columns[key](bool(raw) if key in {"allow_transfer", "remove_role_on_unlink"} else raw), guild_id),
            )

    async def set_roblox_min_age(self, guild_id: int, days: int) -> None:
        await self.execute("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)", (guild_id,))
        await self.execute(
            "UPDATE guild_settings SET roblox_min_account_age_days = ? WHERE guild_id = ?",
            (max(days, 0), guild_id),
        )

    async def create_roblox_link(
        self, state: str, guild_id: int, discord_user_id: int, code_verifier: str
    ) -> None:
        await self.execute("DELETE FROM roblox_links WHERE created_at < ?", (now_ts() - 86400,))
        await self.execute(
            "INSERT INTO roblox_links (state, guild_id, discord_user_id, code_verifier, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (state, guild_id, discord_user_id, code_verifier, now_ts()),
        )

    async def consume_roblox_link(self, state: str) -> sqlite3.Row | None:
        row = await self.fetch_one("SELECT * FROM roblox_links WHERE state = ?", (state,))
        await self.execute("DELETE FROM roblox_links WHERE state = ?", (state,))
        if row is None or now_ts() - int(row["created_at"]) > ROBLOX_LINK_TTL_SECONDS:
            return None
        return row

    async def save_roblox_account(
        self,
        guild_id: int,
        discord_user_id: int,
        roblox_user_id: int,
        username: str,
        display_name: str,
        method: str,
        account_age_days: int | None,
        email_verified: bool,
        bio: str = "",
        bio_ok: bool = True,
    ) -> None:
        await self.execute(
            "INSERT OR REPLACE INTO roblox_accounts (guild_id, discord_user_id, roblox_user_id,"
            " username, display_name, bio, bio_ok, method, account_age_days, email_verified,"
            " verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                guild_id,
                discord_user_id,
                roblox_user_id,
                username,
                display_name,
                bio,
                int(bio_ok),
                method,
                account_age_days,
                int(email_verified),
                now_ts(),
            ),
        )

    async def get_roblox_account(self, guild_id: int, discord_user_id: int) -> sqlite3.Row | None:
        return await self.fetch_one(
            "SELECT * FROM roblox_accounts WHERE guild_id = ? AND discord_user_id = ?",
            (guild_id, discord_user_id),
        )

    async def get_roblox_account_by_roblox_id(
        self, guild_id: int, roblox_user_id: int
    ) -> sqlite3.Row | None:
        return await self.fetch_one(
            "SELECT * FROM roblox_accounts WHERE guild_id = ? AND roblox_user_id = ?",
            (guild_id, roblox_user_id),
        )

    async def delete_roblox_account(self, guild_id: int, discord_user_id: int) -> int:
        return await self.execute(
            "DELETE FROM roblox_accounts WHERE guild_id = ? AND discord_user_id = ?",
            (guild_id, discord_user_id),
        )

    async def list_roblox_accounts(self, guild_id: int, limit: int = 20) -> list[sqlite3.Row]:
        return await self.fetch_all(
            "SELECT * FROM roblox_accounts WHERE guild_id = ? ORDER BY verified_at DESC LIMIT ?",
            (guild_id, limit),
        )

    def close(self) -> None:
        with self._lock:
            self._connection.close()


@dataclass
class AutomodConfig:
    enabled: bool = False
    blocked_words: set[str] = field(default_factory=set)
    ignored_channels: set[int] = field(default_factory=set)
    ignored_roles: set[int] = field(default_factory=set)
    block_invites: bool = True
    block_links: bool = False
    max_mentions: int = 5
    max_caps_ratio: float = 0.70
    min_caps_length: int = 12
    max_newlines: int = 12
    on_violation: str = "delete"
    strike_action: str = "timeout"
    strike_limit: int = 3
    strike_window_days: int = 7
    timeout_seconds: int = 600

    def window_start(self) -> int:
        return now_ts() - int(self.strike_window_days * 86400)


INVITE_PATTERN = re.compile(
    r"(?:discord(?:app)?\.com/invite|discord\.gg|discord\.me|dsc\.gg|invite\.gg)[\s/]+[A-Za-z0-9-]{2,}",
    re.IGNORECASE,
)
LINK_PATTERN = re.compile(
    r"(?:https?://\S+|www\.\S+|\b[a-z0-9][a-z0-9-]{1,30}\.(?:com|net|org|gg|io|me|co|xyz|dev|top|uk|ca)\b)",
    re.IGNORECASE,
)


def match_blocked_word(content: str, words: Iterable[str]) -> str | None:
    lowered = content.lower()
    haystack = canonicalize(content)
    for word in words:
        needle = canonicalize(word)
        if not needle:
            continue
        if re.search(rf"(?<![a-z0-9]){re.escape(needle)}(?![a-z0-9])", lowered):
            return word
        if len(needle) >= 5 and needle in haystack:
            return word
    return None


def analyze_message(content: str, config: AutomodConfig, mention_count: int) -> list[str]:
    violations: list[str] = []
    matched = match_blocked_word(content, config.blocked_words)
    if matched:
        violations.append(f"Blocked word `{truncate(matched, 32)}`")
    if config.block_invites and INVITE_PATTERN.search(content):
        violations.append("Discord invite link")
    if config.block_links and LINK_PATTERN.search(content):
        violations.append("External link")
    if mention_count > config.max_mentions:
        violations.append(f"Mention spam ({mention_count} mentions)")
    letters = [char for char in content if char.isalpha()]
    if len(letters) >= config.min_caps_length:
        ratio = sum(1 for char in letters if char.isupper()) / len(letters)
        if ratio > config.max_caps_ratio:
            violations.append(f"Excessive caps ({ratio:.0%})")
    lines = content.count("\n") + 1
    if lines > config.max_newlines:
        violations.append(f"Message flooding ({lines} lines)")
    return violations


class RobloxError(RuntimeError):
    pass


class RobloxUnavailable(RobloxError):
    """Roblox is temporarily unreachable or throttling us. Always safe to retry later."""


class CooldownError(RuntimeError):
    def __init__(self, seconds: int) -> None:
        super().__init__(f"wait {seconds}s")
        self.seconds = seconds


class SlidingWindowLimiter:
    """Minimal per-key rate limiter so one member cannot hammer the Roblox API."""

    def __init__(self, limit: int, window: float) -> None:
        self.limit = limit
        self.window = window
        self._hits: dict[str, list[float]] = {}
        self._lock = asyncio.Lock()

    async def check(self, key: str) -> int:
        """Return seconds to wait, 0 when the action is allowed."""
        now = time.monotonic()
        async with self._lock:
            hits = [moment for moment in self._hits.get(key, []) if now - moment < self.window]
            if len(hits) >= self.limit:
                self._hits[key] = hits
                return int(self.window - (now - hits[0])) + 1
            hits.append(now)
            self._hits[key] = hits
            if len(self._hits) > 4096:
                self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < self.window}
            return 0


class IntervalGate:
    """Spaces outgoing Roblox calls out so the bot stays under the public rate limit."""

    def __init__(self, min_interval: float) -> None:
        self.min_interval = min_interval
        self._next_at = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        if self.min_interval <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            if now < self._next_at:
                await asyncio.sleep(self._next_at - now)
            self._next_at = time.monotonic() + self.min_interval


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def roblox_created_timestamp(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def account_age_days(value: Any) -> int | None:
    created = roblox_created_timestamp(value)
    return None if created is None else max((now_ts() - created) // 86400, 0)


class RobloxClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._session: aiohttp.ClientSession | None = None
        self.gate = IntervalGate(config.roblox_lookup_min_interval)

    async def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=20),
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
        return self._session

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    async def _json(self, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        await self.gate.wait()
        session = await self.session()
        try:
            async with session.request(method, url, **kwargs) as response:
                body = await response.text()
                if response.status == 429:
                    raise RobloxUnavailable("Roblox is rate limiting the bot. Try again shortly.")
                if response.status >= 500:
                    raise RobloxUnavailable(
                        f"Roblox had a server problem ({response.status}). Try again shortly."
                    )
                if response.status >= 400:
                    raise RobloxError(f"Roblox returned {response.status}: {truncate(body, 200)}")
                return json.loads(body) if body else {}
        except aiohttp.ClientError as error:
            raise RobloxUnavailable("Could not reach Roblox. Try again in a moment.") from error
        except json.JSONDecodeError as error:
            raise RobloxError("Roblox sent a response the bot could not read.") from error

    def authorize_url(self, state: str, challenge: str) -> str:
        return f"{ROBLOX_AUTHORIZE_URL}?" + urlencode(
            {
                "client_id": str(self.config.roblox_client_id),
                "redirect_uri": self.config.roblox_redirect_uri,
                "response_type": "code",
                "scope": self.config.roblox_scopes,
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )

    async def exchange_code(self, code: str, code_verifier: str) -> dict[str, Any]:
        payload = {
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": code_verifier,
            "client_id": str(self.config.roblox_client_id),
            "client_secret": str(self.config.roblox_client_secret),
            "redirect_uri": str(self.config.roblox_redirect_uri),
        }
        return await self._json("POST", ROBLOX_TOKEN_URL, data=payload)

    async def userinfo(self, access_token: str) -> dict[str, Any]:
        return await self._json(
            "GET", ROBLOX_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )

    async def fetch_user(self, roblox_user_id: int) -> dict[str, Any]:
        return await self._json("GET", f"{ROBLOX_USER_API}/{roblox_user_id}")

    async def resolve_username(self, username: str) -> dict[str, Any]:
        wanted = username.strip().lower()
        if not wanted:
            raise RobloxError("Enter your Roblox username first.")
        if not re.fullmatch(r"[a-z0-9_.]{1,20}", wanted):
            raise RobloxError(
                "That does not look like a Roblox username. Use 1-20 letters, numbers, "
                "underscores or dots."
            )
        if wanted.isdigit():
            return await self.fetch_user(int(wanted))
        try:
            batch = await self._json(
                "POST",
                ROBLOX_USERNAME_API,
                json={"usernames": [wanted], "excludeBannedUsers": False},
            )
        except RobloxError:
            batch = {}
        for entry in batch.get("data") or []:
            if str(entry.get("name", "")).lower() == wanted:
                return await self.fetch_user(int(entry["id"]))
        # The batch endpoint only covers existing names, so fall back to search for
        # accounts that are mid-creation or hidden from the batch lookup.
        try:
            search = await self._json(
                "GET",
                f"{ROBLOX_USERNAME_SEARCH_API}?{urlencode({'keyword': wanted, 'limit': 10})}",
            )
        except RobloxError:
            search = {}
        for entry in search.get("searchResults") or []:
            matched = str(entry.get("matchedUsername") or entry.get("name") or "").lower()
            if matched == wanted and entry.get("userId"):
                return await self.fetch_user(int(entry["userId"]))
        raise RobloxError(f"No Roblox account called `{truncate(username, 32)}` exists.")


@dataclass(frozen=True)
class Question:
    key: str
    label: str
    placeholder: str
    long: bool = False
    required: bool = True
    max_length: int = 900


@dataclass(frozen=True)
class ApplicationType:
    key: str
    label: str
    summary: str
    button_style: discord.ButtonStyle
    questions: tuple[Question, ...]


APPLICATION_TYPES: dict[str, ApplicationType] = {
    "pilot": ApplicationType(
        key="pilot",
        label="Regular Pilot",
        summary="For members who want to fly on the network as a pilot.",
        button_style=discord.ButtonStyle.primary,
        questions=(
            Question("callsign", "Name or callsign", "How should we address you?"),
            Question(
                "hours",
                "Flight hours and sim",
                "Total hours, hours in the last month, and where you sim.",
                long=True,
            ),
            Question(
                "aircraft",
                "Aircraft experience",
                "Which aircraft do you fly and what are you comfortable with?",
                long=True,
            ),
            Question(
                "availability",
                "Availability",
                "Timezone, peak hours, and events you can attend.",
                long=True,
            ),
            Question(
                "reason",
                "Why LATC?",
                "Why you want to join and what you bring to the server.",
                long=True,
            ),
        ),
    ),
    "atc": ApplicationType(
        key="atc",
        label="Air Traffic Controller",
        summary="For members who want to control the network.",
        button_style=discord.ButtonStyle.secondary,
        questions=(
            Question("callsign", "Name or callsign", "How should we address you?"),
            Question(
                "hours",
                "Control hours",
                "Total hours on ground, local, tower and approach.",
                long=True,
            ),
            Question(
                "ratings",
                "Ratings and experience",
                "Which positions are you rated for, and where were you trained?",
                long=True,
            ),
            Question(
                "availability",
                "Availability",
                "Timezone, peak hours, and events you can attend.",
                long=True,
            ),
            Question(
                "reason",
                "Why LATC?",
                "Why you want to join and what you bring to the server.",
                long=True,
            ),
        ),
    ),
}


class ApplicationModal(discord.ui.Modal):
    def __init__(
        self,
        bot: "LATCManagement",
        kind: str,
        guild_id: int,
        applicant_id: int,
        intro_message: discord.Message | None = None,
    ) -> None:
        spec = APPLICATION_TYPES[kind]
        super().__init__(title=f"LATC {spec.label} Application", timeout=1800)
        self.bot = bot
        self.kind = kind
        self.guild_id = guild_id
        self.applicant_id = applicant_id
        self.intro_message = intro_message
        for question in spec.questions:
            self.add_item(
                discord.ui.TextInput(
                    label=question.label,
                    placeholder=question.placeholder,
                    custom_id=question.key,
                    required=question.required,
                    max_length=question.max_length,
                    style=discord.TextStyle.long if question.long else discord.TextStyle.short,
                )
            )

    async def on_submit(self, interaction: discord.Interaction) -> None:
        spec = APPLICATION_TYPES[self.kind]
        answers = {
            question.key: (str(child.value) if child.value else "").strip()
            for question, child in zip(spec.questions, self.children)
        }
        pending = await self.bot.db.pending_for_user(self.guild_id, self.applicant_id)
        settings = await self.bot.db.get_guild_settings(self.guild_id)
        account = await self.bot.db.get_roblox_account(self.guild_id, self.applicant_id)
        verified = self.bot.roblox_requirement_met(str(settings["roblox_requirement"]), account)
        if pending is not None:
            await interaction.response.send_message(
                f"You already have application #{pending['id']} under review. Hang tight.",
                ephemeral=True,
            )
        elif not verified:
            await interaction.response.send_message(
                "Your Roblox account is not verified, so this application was not sent. "
                "Run `/verify` in the server, then apply again.",
                ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                "Application sent to the staff team. You will get a DM once it is reviewed.",
                ephemeral=True,
            )
        if self.intro_message is not None:
            try:
                await self.intro_message.delete()
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                pass
        if pending is not None or not verified:
            return
        try:
            app_id = await self.bot.publish_application(self.guild_id, interaction.user, self.kind, answers)
        except Exception as error:
            log.exception("Failed to publish application for %s", self.applicant_id)
            try:
                await interaction.user.send(
                    f"We could not send your {spec.label} application ({error}). Please tell a staff member."
                )
            except discord.HTTPException:
                pass
            return
        log.info("Application #%s created for %s (%s)", app_id, interaction.user.id, self.kind)


class BeginButton(discord.ui.Button):
    def __init__(self, bot: "LATCManagement", kind: str, guild_id: int) -> None:
        spec = APPLICATION_TYPES[kind]
        super().__init__(
            style=spec.button_style,
            label=f"Start {spec.label} application",
            custom_id=f"begin:{guild_id}:{kind}",
        )
        self.bot = bot
        self.kind = kind
        self.guild_id = guild_id

    async def callback(self, interaction: discord.Interaction) -> None:
        if not isinstance(interaction.channel, discord.DMChannel):
            return
        self.disabled = True
        self.view.stop()  # type: ignore[union-attr]
        await interaction.response.send_modal(
            ApplicationModal(
                self.bot,
                self.kind,
                self.guild_id,
                interaction.user.id,
                interaction.message,
            )
        )


class RobloxVerifyButton(discord.ui.Button):
    def __init__(self, bot: "LATCManagement", guild_id: int) -> None:
        super().__init__(
            style=discord.ButtonStyle.bluurple,
            label="Verify",
            custom_id=f"roblox:verify:{guild_id}",
        )
        self.bot = bot
        self.guild_id = guild_id

    async def callback(self, interaction: discord.Interaction) -> None:
        if self.guild_id is None:
            await interaction.response.send_message(
                "Verification only works from inside the server.", ephemeral=True
            )
            return
        await interaction.response.defer(ephemeral=True)
        guild_id = self.guild_id
        user = interaction.user
        settings = await self.bot.db.get_verify_settings(guild_id, self.bot.config)
        account = await self.bot.db.get_roblox_account(guild_id, user.id)
        if account is not None and account["bio_ok"]:
            await interaction.followup.send(
                embed=build_profile_embed(account), ephemeral=True
            )
            return
        try:
            outcome, linked = await self.bot.attempt_verification(guild_id, user, None)
        except Exception:
            log.exception("Verification attempt crashed for %s", user.id)
            await interaction.followup.send(
                "Something went wrong on my side. Your code is still valid, try again shortly.",
                ephemeral=True,
            )
            return
        if outcome == "verified" and linked is not None:
            role_error = await self.bot.grant_verification_role(guild_id, user, settings)
            guild = interaction.guild or self.bot.get_guild(guild_id)
            embed = build_verified_embed(linked, settings.get("role_id"), guild.name if guild else "")
            if role_error:
                embed.add_field(name="Role", value=role_error, inline=False)
            log.info("Verification succeeded for %s", user.id)
            await interaction.followup.send(embed=embed, ephemeral=True)
            return
        message = VERIFY_MESSAGES.get(outcome, "That did not work. Run `/verify` to start over.")
        session = await self.bot.db.get_session(guild_id, user.id)
        if session is not None and self.bot.db.session_is_live(
            session, int(settings["code_expiry_minutes"])
        ):
            embed = build_verify_embed(
                str(session["code"]),
                int(settings["code_expiry_minutes"]),
                session["username"],
                error=message,
            )
            await interaction.followup.send(embed=embed, ephemeral=True)
            return
        await interaction.followup.send(message, ephemeral=True)


class DMIntroView(discord.ui.View):
    def __init__(self, bot: "LATCManagement", kind: str, guild_id: int) -> None:
        super().__init__(timeout=1800)
        self.bot = bot
        self.add_item(BeginButton(bot, kind, guild_id))
        self.add_item(RobloxVerifyButton(bot, guild_id))


class ApplicationStartButton(discord.ui.Button):
    def __init__(self, bot: "LATCManagement", kind: str) -> None:
        spec = APPLICATION_TYPES[kind]
        super().__init__(
            style=spec.button_style, label=spec.label, custom_id=f"app:start:{kind}"
        )
        self.bot = bot
        self.kind = kind

    async def callback(self, interaction: discord.Interaction) -> None:
        if interaction.guild is None:
            return
        guild_id = interaction.guild.id
        pending = await self.bot.db.pending_for_user(guild_id, interaction.user.id)
        if pending is not None:
            await interaction.response.send_message(
                f"You already have application #{pending['id']} under review. "
                "We will DM you when the staff team is done with it.",
                ephemeral=True,
            )
            return
        settings = await self.bot.db.get_guild_settings(guild_id)
        requirement = str(settings["roblox_requirement"])
        account = await self.bot.db.get_roblox_account(guild_id, interaction.user.id)
        if not self.bot.roblox_requirement_met(requirement, account):
            await self.bot.require_verification(
                interaction, guild_id, interaction.user, interaction.guild.name, requirement
            )
            return
        spec = APPLICATION_TYPES[self.kind]
        await interaction.response.defer(ephemeral=True)
        embed = discord.Embed(
            title=f"LATC {spec.label} Application",
            description=(
                f"{spec.summary}\n\n"
                "Press the button below and answer the questions in this DM. "
                "The staff team reviews every submission by hand, and you will get a reply here "
                "whether you are accepted or not."
            ),
            color=ACCENT_COLOR,
        )
        embed.set_footer(text=f"Applying in {interaction.guild.name}")
        try:
            await interaction.user.send(
                embed=embed, view=DMIntroView(self.bot, self.kind, guild_id)
            )
        except discord.Forbidden:
            await interaction.followup.send(
                "I could not DM you. Turn on server messages from members, then try again.",
                ephemeral=True,
            )
            return
        except discord.HTTPException as error:
            log.warning("Failed to DM %s: %s", interaction.user.id, error)
            await interaction.followup.send(
                "Something went wrong while messaging you. Try again later.", ephemeral=True
            )
            return
        await interaction.followup.send("Check your DMs to continue.", ephemeral=True)
        log.info("Application DM opened for %s (%s)", interaction.user.id, self.kind)


class PanelView(discord.ui.View):
    def __init__(self, bot: "LATCManagement", guild_id: int) -> None:
        super().__init__(timeout=None)
        self.bot = bot
        for kind in APPLICATION_TYPES:
            self.add_item(ApplicationStartButton(bot, kind))
        self.add_item(RobloxVerifyButton(bot, guild_id))


def build_panel_embed(guild: discord.Guild, requirement: str, bio_rule: str) -> discord.Embed:
    embed = discord.Embed(
        title="LATC Applications",
        description=(
            "Want to join the team? Pick the role that fits you below and the bot will "
            "walk you through the form in your DMs."
        ),
        color=ACCENT_COLOR,
    )
    for spec in APPLICATION_TYPES.values():
        embed.add_field(name=spec.label, value=spec.summary, inline=False)
    if requirement != "off":
        rule = (
            "Run `/verify` to get a one time code, put it in your Roblox profile bio, then press "
            "Verify. The bot reads your public bio to confirm it is really your account."
        )
        embed.add_field(name="Roblox verification", value=rule, inline=False)
    embed.set_footer(text=f"{guild.name} | one open application at a time")
    return embed


def build_profile_embed(account: sqlite3.Row, note: str | None = None) -> discord.Embed:
    color = APPROVED_COLOR if account["bio_ok"] else UNVERIFIED_COLOR
    embed = discord.Embed(
        title="Roblox account",
        description=roblox_summary(account),
        color=color,
        timestamp=datetime.now(),
    )
    if str(account["display_name"] or ""):
        embed.add_field(name="Roblox display name", value=str(account["display_name"]), inline=True)
    if account["account_age_days"] is not None:
        embed.add_field(name="Account age", value=f"{account['account_age_days']} days", inline=True)
    bio = str(account["bio"] or "")
    embed.add_field(
        name="Roblox bio",
        value=truncate(bio, 900) if bio else "This account has no bio set.",
        inline=False,
    )
    if note:
        embed.add_field(name="Still to do", value=note, inline=False)
    return embed


BIO_RULES: dict[str, str] = {
    "off": "any Roblox account is accepted",
    "discord": "the bio or display name must contain the member's Discord name",
    "code": "the bio must contain the one time code the bot gives them",
}


def code_instructions(code: str, expiry_minutes: int, username: str | None) -> str:
    who = f"`{username}`" if username else "your Roblox username"
    return "\n".join(
        [
            f"1. Copy this code: `{code}`",
            f"2. Open your Roblox profile for {who}.",
            f"3. Add `{code}` to your **About/Bio** section and save.",
            "4. Come back here and press **Verify**.",
            "",
            f"Your code expires in {expiry_minutes} minute(s).",
        ]
    )


def build_verify_embed(
    code: str, expiry_minutes: int, username: str | None, error: str | None = None
) -> discord.Embed:
    embed = discord.Embed(
        title="🔐 Roblox Verification",
        description=code_instructions(code, expiry_minutes, username),
        color=UNVERIFIED_COLOR,
    )
    embed.add_field(
        name="Edit your bio",
        value=f"[Open your Roblox About/Bio page]({ROBLOX_BIO_EDIT_URL})",
        inline=False,
    )
    if error:
        embed.add_field(name="Last attempt", value=error, inline=False)
    return embed


def build_verified_embed(
    account: sqlite3.Row, role_id: int | None, guild_name: str
) -> discord.Embed:
    embed = discord.Embed(
        title="✅ Verification successful!",
        description=(
            "Your Discord account is now linked to your Roblox account.\n"
            "This proves you own the Roblox account. You can remove the code from your "
            "bio now, though you can leave it there if you prefer."
        ),
        color=APPROVED_COLOR,
    )
    roblox_user_id = int(account["roblox_user_id"])
    embed.add_field(
        name="Roblox",
        value=f"[{account['username']}](https://www.roblox.com/users/{roblox_user_id}/profile)",
        inline=True,
    )
    embed.add_field(name="Roblox UserId", value=f"`{roblox_user_id}`", inline=True)
    if role_id:
        embed.add_field(name="Role", value="You have been given the Verified role.", inline=False)
    else:
        embed.add_field(
            name="Role",
            value="No verification role is configured on this server.",
            inline=False,
        )
    embed.set_footer(text=f"Verified in {guild_name}")
    return embed


VERIFY_MESSAGES: dict[str, str] = {
    "no_code": "You do not have a verification code yet. Run `/verify` to get one.",
    "no_username": (
        "I need your Roblox username first. Run `/verify username:YourRobloxName`, then press "
        "Verify again."
    ),
    "bad_code": (
        "I could not find the code in that Roblox bio. Make sure the code is spelled exactly "
        "as shown and that you saved your profile, then press Verify again."
    ),
    "expired": "That code has expired. Run `/verify` to get a fresh one.",
    "rate_limited": "You are going a little fast. Wait a few seconds and press Verify again.",
    "locked": (
        "You have used all your attempts. Run `/verify` again to start over with a new code."
    ),
    "unknown_user": "I could not find a Roblox account with that username. Check the spelling.",
    "taken": (
        "That Roblox account is already linked to a different Discord account here. If that is "
        "wrong, ask a staff member to unlink it."
    ),
    "banned": "That Roblox account is banned, so it cannot be used for verification.",
    "too_new": "That Roblox account is too new for this server's requirements.",
    "unavailable": (
        "Roblox is not answering right now, so I could not check your profile. Try again in a "
        "minute. Your code is still good."
    ),
}


def code_in_bio(code: str, bio: str, roblox_display_name: str) -> bool:
    """True when the exact code appears in the public bio/about text.

    Matching is case-insensitive and tolerates surrounding whitespace so a code pasted
    with a stray space still counts, but the characters themselves must be exact.
    """
    if not code:
        return False
    haystack = f"{bio}\n{roblox_display_name}".lower()
    return code.strip().lower() in haystack


def roblox_summary(account: sqlite3.Row | None) -> str:
    if account is None:
        return "Not verified"
    method = str(account["method"])
    label = {
        "oauth": "verified with Roblox sign in",
        "profile": "username and bio check",
        "manual": "verified by staff",
        "lookup": "old username check, run /verify again",
    }.get(method, method)
    age = account["account_age_days"]
    age_text = f", {age}d old" if age is not None else ""
    if method == "profile" and not account["bio_ok"]:
        age_text += ", bio check not passed"
    roblox_user_id = int(account["roblox_user_id"])
    username = str(account["username"])
    if roblox_user_id > 0:
        identity = f"[{username}](https://www.roblox.com/users/{roblox_user_id}/profile) (`{roblox_user_id}`)"
    else:
        identity = username
    return f"{identity}{age_text} - {label}"


def build_application_embed(
    app_id: int,
    kind: str,
    user: discord.abc.User,
    answers: dict[str, str],
    roblox: sqlite3.Row | None = None,
) -> discord.Embed:
    spec = APPLICATION_TYPES[kind]
    embed = discord.Embed(
        title=f"New {spec.label} application #{app_id}",
        color=PENDING_COLOR,
        timestamp=datetime.now(),
    )
    embed.add_field(name="Applicant", value=f"{user.mention}\n`{user.id}`", inline=True)
    embed.add_field(name="Role", value=spec.label, inline=True)
    embed.add_field(name="Roblox", value=roblox_summary(roblox), inline=False)
    if roblox is not None and str(roblox["bio"]):
        embed.add_field(
            name="Roblox bio",
            value=truncate(str(roblox["bio"]), 800),
            inline=False,
        )
    for question in spec.questions:
        embed.add_field(
            name=question.label,
            value=truncate(answers.get(question.key) or "no answer", 1000) or "no answer",
            inline=False,
        )
    embed.set_footer(text=f"Application ID {app_id}")
    return embed


class ApplicationReviewView(discord.ui.View):
    def __init__(self, bot: "LATCManagement", app_id: int, kind: str) -> None:
        super().__init__(timeout=None)
        self.bot = bot
        self.app_id = app_id
        self.kind = kind
        self.add_item(
            discord.ui.Button(
                style=discord.ButtonStyle.success,
                label="Accept",
                custom_id=f"app:accept:{app_id}",
            )
        )
        self.add_item(
            discord.ui.Button(
                style=discord.ButtonStyle.danger,
                label="Deny",
                custom_id=f"app:deny:{app_id}",
            )
        )

    async def callback(self, interaction: discord.Interaction) -> None:
        if not self.bot.is_staff(interaction.user):
            await interaction.response.send_message(
                "Only staff can review applications.", ephemeral=True
            )
            return
        custom_id = str(interaction.data.get("custom_id", ""))
        accepted = custom_id.startswith("app:accept")
        await interaction.response.defer()
        row = await self.bot.db.get_application(self.app_id)
        if row is None:
            await interaction.edit_message(
                content=f"Application #{self.app_id} no longer exists.", view=None
            )
            return
        if row["status"] != "pending":
            await interaction.edit_message(
                content=f"Application #{self.app_id} was already {row['status']}.",
                view=None,
            )
            return
        if accepted and interaction.guild is not None:
            settings = await self.bot.db.get_guild_settings(interaction.guild.id)
            account = await self.bot.db.get_roblox_account(
                interaction.guild.id, int(row["user_id"])
            )
            if not self.bot.roblox_requirement_met(str(settings["roblox_requirement"]), account):
                await interaction.followup.send(
                    "This applicant has not verified a Roblox account, so you cannot accept "
                    "them yet. Run `/roblox-config check` to look at it, `/roblox-config override` "
                    "if you verified it yourself, or `/roblox-config requirement mode:any` to "
                    "relax the rule.",
                    ephemeral=True,
                )
                return
        status = "approved" if accepted else "denied"
        await self.bot.db.set_application_status(self.app_id, status, interaction.user.id)
        self.disable_all_items()
        label = APPLICATION_TYPES[self.kind].label
        embed = interaction.message.embed if interaction.message else None
        if embed is None:
            embed = discord.Embed(title=f"Application #{self.app_id}", color=ACCENT_COLOR)
        embed.color = APPROVED_COLOR if accepted else DENIED_COLOR
        embed.add_field(
            name="Status",
            value=(
                f"{'Accepted' if accepted else 'Denied'} by {interaction.user.mention} "
                f"on {datetime.now().strftime('%Y-%m-%d %H:%M')} UTC"
            ),
            inline=True,
        )
        embed.set_footer(text=f"Application ID {self.app_id} | {status}")
        await interaction.edit_message(embed=embed, view=self)
        note = (
            f"Your {label} application was accepted. A staff member will follow up in the server."
            if accepted
            else f"Your {label} application was not accepted this time. You can apply again later."
        )
        try:
            applicant = await self.bot.fetch_user(int(row["user_id"]))
            await applicant.send(note)
        except (discord.NotFound, discord.Forbidden, discord.HTTPException):
            log.info("Could not DM %s about application #%s", row["user_id"], self.app_id)
        if accepted and interaction.guild is not None:
            role_id = self.bot.config.role_for_kind(self.kind)
            role = interaction.guild.get_role(role_id) if role_id else None
            member = interaction.guild.get_member(int(row["user_id"]))
            if role is not None and member is not None:
                try:
                    await member.add_roles(role, reason=f"Application #{self.app_id} accepted")
                except discord.Forbidden:
                    log.warning("Missing permissions to grant role %s to %s", role.id, member.id)
        log.info("Application #%s %s by %s", self.app_id, status, interaction.user.id)


class LATCManagement(commands.Bot):
    def __init__(self, config: Config, db: Database) -> None:
        intents = discord.Intents.default()
        intents.message_content = True
        intents.members = True
        if hasattr(intents, "moderation"):
            intents.moderation = True
        super().__init__(
            command_prefix=commands.when_mentioned,
            intents=intents,
            help_command=None,
            allowed_mentions=discord.AllowedMentions.none(),
        )
        self.config = config
        self.db = db
        self.roblox = RobloxClient(config)
        self._copied_to_dev_guild = False
        self._views_restored = False
        self._web_runner: web.AppRunner | None = None
        self.verify_limiter = SlidingWindowLimiter(limit=10, window=600.0)
        self.roblox_lookup_limiter = SlidingWindowLimiter(limit=8, window=60.0)
        register_commands(self)

    def is_staff(self, member: discord.abc.User) -> bool:
        if member.id in self.config.owner_ids:
            return True
        if not isinstance(member, discord.Member):
            return False
        if self.config.staff_role_id and member.get_role(self.config.staff_role_id) is not None:
            return True
        permissions = member.guild_permissions
        return permissions.administrator or permissions.manage_messages or permissions.manage_roles

    def is_automod_exempt(self, message: discord.Message, config: AutomodConfig) -> bool:
        if message.channel.id in config.ignored_channels:
            return True
        member = message.author
        if not isinstance(member, discord.Member):
            return False
        if config.ignored_roles and any(role.id in config.ignored_roles for role in member.roles):
            return True
        if self.is_staff(member):
            return True
        permissions = member.guild_permissions
        return permissions.administrator or permissions.manage_messages

    async def publish_application(
        self, guild_id: int, user: discord.abc.User, kind: str, answers: dict[str, str]
    ) -> int:
        guild = self.get_guild(guild_id)
        if guild is None:
            raise RuntimeError("The bot is not in that server anymore.")
        review = (
            guild.get_channel(self.config.review_channel_id)
            if self.config.review_channel_id
            else None
        )
        if review is None or not isinstance(review, discord.TextChannel):
            raise RuntimeError("APPLICATION_REVIEW_CHANNEL_ID is not set or not visible to me.")
        app_id = await self.db.create_application(guild.id, user.id, kind, answers)
        roblox = await self.db.get_roblox_account(guild.id, user.id)
        try:
            message = await review.send(
                embed=build_application_embed(app_id, kind, user, answers, roblox),
                view=ApplicationReviewView(self, app_id, kind),
            )
        except Exception:
            await self.db.set_application_status(app_id, "failed", None, "could not post")
            raise
        await self.db.set_application_message(app_id, review.id, message.id)
        return app_id

    @staticmethod
    def roblox_requirement_met(requirement: str, account: sqlite3.Row | None) -> bool:
        if requirement == "off":
            return True
        if account is None:
            return False
        method = str(account["method"])
        if requirement == "oauth":
            return method in {"oauth", "manual"}
        if requirement == "profile":
            return method in {"oauth", "manual"} or bool(account["bio_ok"])
        return True

    async def start_verification(
        self, guild_id: int, user: discord.abc.User, username: str | None
    ) -> tuple[sqlite3.Row, dict[str, Any]]:
        """Create (or reuse) the member's code and remember any username they supplied."""
        settings = await self.db.get_verify_settings(guild_id, self.config)
        session = await self.db.get_or_create_session(
            guild_id, user.id, int(settings["code_expiry_minutes"])
        )
        if username:
            await self.db.set_session_username(guild_id, user.id, username.strip())
            session = await self.db.get_session(guild_id, user.id) or session
        return session, settings

    async def attempt_verification(
        self, guild_id: int, user: discord.abc.User, username: str | None
    ) -> tuple[str, sqlite3.Row | None]:
        """Run one verification attempt.

        Returns (outcome, account) where outcome is one of:
          verified | no_code | no_username | bad_code | expired | rate_limited
          | unknown_user | taken | banned | too_new | unavailable | locked
        """
        settings = await self.db.get_verify_settings(guild_id, self.config)
        expiry = int(settings["code_expiry_minutes"])
        session = await self.db.get_session(guild_id, user.id)
        if session is None or not self.db.session_is_live(session, expiry):
            return ("expired" if session is not None else "no_code"), None

        target = (username or session["username"] or "").strip()
        if not target:
            return "no_username", None

        cooldown = int(settings["cooldown_seconds"])
        wait = cooldown - (now_ts() - int(session["last_attempt_at"] or 0))
        if wait > 0:
            return "rate_limited", None

        blocked = await self.verify_limiter.check(f"{guild_id}:{user.id}")
        if blocked:
            return "rate_limited", None
        blocked = await self.roblox_lookup_limiter.check(str(guild_id))
        if blocked:
            return "rate_limited", None

        if int(session["attempts"]) >= int(settings["max_attempts"]):
            return "locked", None

        await self.db.record_attempt(guild_id, user.id)
        try:
            profile = await self.roblox.resolve_username(target)
        except RobloxUnavailable:
            log.warning("Roblox unavailable while verifying %s", user.id)
            return "unavailable", None
        except RobloxError as error:
            log.info("Verification lookup failed for %s: %s", user.id, error)
            return "unknown_user", None

        roblox_user_id = int(profile.get("id") or 0)
        if not roblox_user_id:
            return "unknown_user", None
        if profile.get("isBanned"):
            return "banned", None

        bio = str(profile.get("description") or "")
        if not code_in_bio(str(session["code"]), bio, str(profile.get("displayName") or "")):
            return "bad_code", None

        guild_settings = await self.db.get_guild_settings(guild_id)
        min_age = int(guild_settings["roblox_min_account_age_days"])
        problem = await self.store_roblox_account(
            guild_id=guild_id,
            user=user,
            roblox_user_id=roblox_user_id,
            username=str(profile.get("name") or target),
            display_name=str(profile.get("displayName") or target),
            method="profile",
            age_days=account_age_days(profile.get("created")),
            email_verified=bool(profile.get("hasVerifiedEmail")),
            bio=bio,
            bio_ok=True,
            min_age_days=min_age,
            allow_transfer=bool(settings["allow_transfer"]),
        )
        if problem == "taken":
            return "taken", None
        if problem is not None:
            return "too_new" if min_age and "day(s) old" in problem else "unavailable", None

        # A successful use burns the code immediately so it can never be replayed.
        await self.db.consume_session(guild_id, user.id)
        account = await self.db.get_roblox_account(guild_id, user.id)
        return "verified", account

    async def grant_verification_role(
        self, guild_id: int, user: discord.abc.User, settings: dict[str, Any]
    ) -> str | None:
        role_id = settings.get("role_id")
        if not role_id:
            return None
        guild = self.get_guild(guild_id)
        member = guild.get_member(user.id) if guild else None
        if member is None:
            return "I could not find you in the server to give the role."
        role = guild.get_role(int(role_id))  # type: ignore[union-attr]
        if role is None:
            return "The configured verification role no longer exists. Ask an admin to fix it."
        if role in member.roles:
            return None
        try:
            await member.add_roles(role, reason="Roblox verification completed")
        except discord.Forbidden:
            return "I lack permission to give the verification role. Check my role position."
        except discord.HTTPException as error:
            log.warning("Could not grant verification role to %s: %s", user.id, error)
            return "Something went wrong while giving you the role."
        return None

    async def unlink_account(
        self, guild_id: int, user: discord.abc.User, settings: dict[str, Any] | None = None
    ) -> bool:
        """Remove the link, clear the code, and optionally drop the verification role."""
        existed = bool(await self.db.delete_roblox_account(guild_id, user.id))
        await self.db.clear_session(guild_id, user.id)
        await self.db.delete_bio_code(guild_id, user.id)
        if not settings:
            settings = await self.db.get_verify_settings(guild_id, self.config)
        if settings.get("remove_role_on_unlink") and settings.get("role_id"):
            guild = self.get_guild(guild_id)
            member = guild.get_member(user.id) if guild else None
            role = guild.get_role(int(settings["role_id"])) if guild else None
            if member is not None and role is not None and role in member.roles:
                try:
                    await member.remove_roles(role, reason="Roblox account unlinked")
                except discord.HTTPException as error:
                    log.warning("Could not remove verification role from %s: %s", user.id, error)
        return existed

    async def send_verification_guide(
        self, guild_id: int, user: discord.abc.User, guild_name: str
    ) -> str:
        verify_settings = await self.db.get_verify_settings(guild_id, self.config)
        session, verify_settings = await self.start_verification(guild_id, user, None)
        embed = build_verify_embed(
            str(session["code"]), int(verify_settings["code_expiry_minutes"]), None
        )
        if self.config.roblox_oauth_ready:
            verifier, challenge = pkce_pair()
            state = secrets.token_urlsafe(32)
            await self.db.create_roblox_link(state, guild_id, user.id, verifier)
            embed.add_field(
                name="Or sign in with Roblox",
                value=f"[Verify with Roblox instead]({self.roblox.authorize_url(state, challenge)})",
                inline=False,
            )
        embed.set_footer(text=f"Verification for {guild_name}")
        try:
            await user.send(embed=embed)
        except (discord.Forbidden, discord.HTTPException):
            return "dm_closed"
        return "dm_sent"

    async def require_verification(
        self,
        interaction: discord.Interaction,
        guild_id: int,
        user: discord.abc.User,
        guild_name: str,
        requirement: str,
    ) -> None:
        status = await self.send_verification_guide(guild_id, user, guild_name)
        if status == "dm_sent":
            body = "Verify your Roblox account first, then apply again. I sent you the steps in your DMs."
        else:
            body = (
                "Verify your Roblox account first, then apply again. I could not DM you, so run "
                "`/verify username:YourRobloxName` in the server."
            )
        if requirement == "oauth":
            body += " This server needs a real Roblox sign in, not just a username."
        await interaction.response.send_message(body, ephemeral=True)

    async def store_roblox_account(
        self,
        guild_id: int,
        user: discord.abc.User,
        roblox_user_id: int,
        username: str,
        display_name: str,
        method: str,
        age_days: int | None,
        email_verified: bool,
        bio: str = "",
        bio_ok: bool = True,
        min_age_days: int = 0,
        allow_transfer: bool = False,
    ) -> str | None:
        profile = await self.roblox.fetch_user(roblox_user_id)
        if profile.get("isBanned"):
            return f"That Roblox account ({username}) is banned, so it cannot be verified."
        age_days = account_age_days(profile.get("created")) or age_days
        if min_age_days and age_days is not None and age_days < min_age_days:
            return (
                f"That Roblox account is {age_days} day(s) old. This server needs at least "
                f"{min_age_days} day(s)."
            )
        owner = (
            await self.db.get_roblox_account_by_roblox_id(guild_id, roblox_user_id)
            if roblox_user_id > 0
            else None
        )
        if owner is not None and int(owner["discord_user_id"]) != user.id:
            if not allow_transfer:
                return "taken"
            # Hand the account over: drop the previous holder's link first so the
            # one-Roblox-account-per-Discord-user invariant still holds.
            await self.db.delete_roblox_account(guild_id, int(owner["discord_user_id"]))
            await self.db.clear_session(guild_id, int(owner["discord_user_id"]))
            log.info(
                "Roblox account %s transferred from %s to %s",
                username,
                owner["discord_user_id"],
                user.id,
            )
        await self.db.save_roblox_account(
            guild_id,
            user.id,
            roblox_user_id,
            username,
            display_name,
            method,
            age_days,
            email_verified or bool(profile.get("hasVerifiedEmail")),
            bio or str(profile.get("description") or ""),
            bio_ok,
        )
        log.info("Roblox account %s linked to %s via %s", username, user.id, method)
        return None

    def _verify_page(self, title: str, message: str) -> web.Response:
        body = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<title>{title}</title></head>"
            "<body style='font-family:system-ui;background:#1F6FEB;color:#fff;"
            "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
            "<div style='text-align:center;max-width:32rem;padding:2rem'>"
            "<h1 style='font-size:2rem;margin:0 0 1rem'>{title}</h1>"
            "<p style='font-size:1.1rem'>{message}</p></div></body></html>"
        ).format(title=html.escape(title), message=html.escape(message))
        return web.Response(text=body, content_type="text/html")

    async def handle_roblox_callback(self, request: web.Request) -> web.Response:
        if request.query.get("error"):
            return self._verify_page(
                "Verification cancelled",
                "You declined the Roblox sign in, so nothing was linked. You can try again from "
                "the server with /verify.",
            )
        state = request.query.get("state", "")
        code = request.query.get("code", "")
        link = await self.db.consume_roblox_link(state)
        if not code or link is None:
            return self._verify_page(
                "Link expired",
                "This verification link is no longer valid. Run /verify in the server to get a "
                "fresh one.",
            )
        guild_id = int(link["guild_id"])
        try:
            tokens = await self.roblox.exchange_code(code, str(link["code_verifier"]))
            access_token = str(tokens.get("access_token") or "")
            if not access_token:
                raise RobloxError("Roblox did not return an access token.")
            profile = await self.roblox.userinfo(access_token)
            roblox_user_id = int(profile["sub"])
        except (RobloxError, KeyError, ValueError) as error:
            log.warning("Roblox verification failed for %s: %s", link["discord_user_id"], error)
            return self._verify_page("Verification failed", str(error))
        try:
            user = await self.fetch_user(int(link["discord_user_id"]))
        except discord.NotFound:
            return self._verify_page(
                "Verification failed", "That Discord account no longer exists."
            )
        settings = await self.db.get_guild_settings(guild_id)
        problem = await self.store_roblox_account(
            guild_id=guild_id,
            user=user,
            roblox_user_id=roblox_user_id,
            username=str(profile.get("preferred_username") or profile.get("name") or roblox_user_id),
            display_name=str(profile.get("name") or ""),
            method="oauth",
            age_days=account_age_days(profile.get("created_at")),
            email_verified=bool(profile.get("email_verified")),
            min_age_days=int(settings["roblox_min_account_age_days"]),
        )
        if problem is not None:
            return self._verify_page("Verification failed", problem)
        try:
            await user.send(
                f"Your Roblox account `{profile.get('preferred_username') or roblox_user_id}` is "
                "verified. You can now apply for a role from the panel."
            )
        except (discord.Forbidden, discord.HTTPException):
            pass
        return self._verify_page(
            "Verified", "You can close this tab and go back to Discord."
        )

    async def start_callback_server(self) -> None:
        if not self.config.roblox_oauth_ready or self._web_runner is not None:
            return
        app = web.Application()
        app.router.add_get(ROBLOX_CALLBACK_PATH, self.handle_roblox_callback)
        app.router.add_get("/health", lambda request: web.Response(text="ok"))
        runner = web.AppRunner(app)
        await runner.setup()
        try:
            await web.TCPSite(runner, "0.0.0.0", self.config.roblox_callback_port).start()
        except OSError as error:
            log.error("Could not start the Roblox callback server: %s", error)
            await runner.cleanup()
            return
        self._web_runner = runner
        log.info(
            "Roblox verification live. Register this exact redirect URL in the Roblox Creator "
            "Dashboard: %s",
            self.config.roblox_redirect_uri,
        )

    async def close(self) -> None:
        if self._web_runner is not None:
            await self._web_runner.cleanup()
            self._web_runner = None
        await self.roblox.close()
        await super().close()

    async def apply_punishment(
        self, member: discord.Member, action: str, seconds: int, reason: str
    ) -> str:
        if action == "delete":
            return "message deleted"
        try:
            if action == "timeout" and hasattr(member, "timeout"):
                await member.timeout(timedelta(seconds=seconds), reason=reason)
                return f"timed out for {max(seconds // 60, 1)} minute(s)"
            if action == "kick":
                await member.kick(reason=reason)
                return "kicked"
            if action == "ban":
                await member.ban(reason=reason, delete_message_days=0)
                return "banned"
        except discord.Forbidden:
            log.warning("Missing permissions to %s %s", action, member.id)
            return f"could not {action} (missing permissions)"
        except discord.HTTPException as error:
            log.warning("Failed to %s %s: %s", action, member.id, error)
            return f"could not {action} (http {error.status})"
        return f"action {action} is not available"

    async def handle_automod(self, message: discord.Message) -> None:
        if message.guild is None or message.author.bot or not message.content.strip():
            return
        if not self.is_ready():
            return
        config = await self.db.get_automod(message.guild.id)
        if not config.enabled or self.is_automod_exempt(message, config):
            return
        mentions = len(message.mentions) + len(message.mention_roles)
        violations = analyze_message(message.content, config, mentions)
        if not violations:
            return
        reason = "; ".join(violations)
        log.info("Automod hit in %s by %s: %s", message.guild.id, message.author.id, reason)
        try:
            await message.delete()
        except (discord.NotFound, discord.Forbidden, discord.HTTPException):
            pass
        member = message.author if isinstance(message.author, discord.Member) else None
        action = config.on_violation
        if member is not None:
            await self.db.add_warning(
                message.guild.id, member.id, self.user.id if self.user else None, reason
            )
            strikes = await self.db.count_warnings(
                message.guild.id, member.id, config.window_start()
            )
            result = await self.apply_punishment(
                member, action, config.timeout_seconds, f"Automod: {reason}"
            )
            if config.strike_action != "none" and strikes >= config.strike_limit:
                escalated = await self.apply_punishment(
                    member,
                    config.strike_action,
                    config.timeout_seconds,
                    f"Automod strike {strikes}/{config.strike_limit}: {reason}",
                )
                result = f"{result}, strike {strikes} -> {escalated}"
            remaining = max(config.strike_limit - strikes, 0)
            try:
                await member.send(
                    f"Your message in **{message.guild.name}** was removed by automod.\n"
                    f"Reason: {reason}\n"
                    f"Action: {result}\n"
                    f"Strikes: {strikes}/{config.strike_limit}."
                    + (f" {remaining} more before the strike action." if remaining else "")
                )
            except discord.HTTPException:
                pass
        await self.log_moderation(
            guild=message.guild,
            user=message.author,
            reason=reason,
            action=action,
            message=message,
        )

    async def log_moderation(
        self,
        guild: discord.Guild,
        user: discord.abc.User,
        reason: str,
        action: str,
        message: discord.Message | None = None,
    ) -> None:
        channel = (
            guild.get_channel(self.config.modlog_channel_id)
            if self.config.modlog_channel_id
            else None
        )
        if channel is None or not isinstance(channel, discord.TextChannel):
            return
        embed = discord.Embed(
            title="Automod",
            color=DENIED_COLOR if action != "delete" else PENDING_COLOR,
            timestamp=datetime.now(),
        )
        embed.add_field(name="User", value=f"{user.mention}\n`{user.id}`", inline=True)
        embed.add_field(name="Action", value=action, inline=True)
        if message is not None:
            embed.add_field(name="Channel", value=message.channel.mention, inline=True)
        embed.add_field(name="Reason", value=truncate(reason, 1000), inline=False)
        if message is not None and message.content:
            embed.add_field(name="Message", value=truncate(message.content, 1000), inline=False)
        embed.set_footer(text=f"{guild.name} | automod")
        try:
            await channel.send(embed=embed)
        except discord.HTTPException as error:
            log.warning("Failed to write modlog: %s", error)

    async def on_ready(self) -> None:
        log.info("Logged in as %s in %s guild(s)", self.user, len(self.guilds))
        await self.sync_commands()
        await self.start_callback_server()
        if self._views_restored:
            return
        self._views_restored = True
        for guild in self.guilds:
            panel_id = await self.db.get_panel_message_id(guild.id)
            if panel_id:
                try:
                    await self.add_view(PanelView(self, guild.id), message_id=panel_id)
                except (discord.HTTPException, ValueError) as error:
                    log.warning("Could not restore the panel in %s: %s", guild.id, error)
        for row in await self.db.restorable_applications():
            try:
                await self.add_view(
                    ApplicationReviewView(self, int(row["id"]), str(row["kind"])),
                    message_id=int(row["message_id"]),
                )
            except (discord.HTTPException, ValueError, TypeError) as error:
                log.warning("Could not restore review view %s: %s", row["id"], error)

    async def sync_commands(self) -> None:
        target = discord.Object(id=self.config.guild_id) if self.config.guild_id else None
        if target is not None and not self._copied_to_dev_guild:
            self.tree.copy_global_to(guild=target)
            self._copied_to_dev_guild = True
        try:
            synced = await self.tree.sync(guild=target)
            log.info("Synced %s command(s) to %s", len(synced), target.id if target else "global")
        except discord.HTTPException as error:
            log.error("Command sync failed: %s", error)


def staff_check(interaction: discord.Interaction) -> bool:
    bot: LATCManagement = interaction.client  # type: ignore[assignment]
    return bot.is_staff(interaction.user)


def admin_check(interaction: discord.Interaction) -> bool:
    bot: LATCManagement = interaction.client  # type: ignore[assignment]
    if interaction.user.id in bot.config.owner_ids:
        return True
    if isinstance(interaction.user, discord.Member):
        return interaction.user.guild_permissions.administrator
    return False


def register_commands(bot: LATCManagement) -> None:
    tree = bot.tree

    @tree.command(name="panel", description="Post the application panel in this channel.")
    @app_commands.check(staff_check)
    async def panel(interaction: discord.Interaction) -> None:
        if not isinstance(interaction.channel, discord.TextChannel):
            await interaction.response.send_message(
                "This channel cannot hold the panel.", ephemeral=True
            )
            return
        await interaction.response.defer(ephemeral=True)
        settings = await bot.db.get_guild_settings(interaction.guild.id)
        message = await interaction.channel.send(
            embed=build_panel_embed(
                interaction.guild,
                str(settings["roblox_requirement"]),
                str(settings["roblox_bio_rule"]),
            ),
            view=PanelView(bot, interaction.guild.id),
        )
        await bot.db.set_panel_message_id(interaction.guild.id, message.id)
        await interaction.followup.send(
            "Panel posted. It keeps working after restarts.", ephemeral=True
        )

    @tree.command(name="automod", description="Show the automod configuration.")
    @app_commands.check(staff_check)
    async def automod(interaction: discord.Interaction) -> None:
        config = await bot.db.get_automod(interaction.guild.id)
        words = await bot.db.list_blocked_words(interaction.guild.id)
        embed = discord.Embed(
            title="Automod",
            color=ACCENT_COLOR if config.enabled else 0x6B7280,
        )
        embed.add_field(name="Status", value="Enabled" if config.enabled else "Disabled", inline=True)
        embed.add_field(name="Per message", value=config.on_violation, inline=True)
        embed.add_field(name="Strike action", value=config.strike_action, inline=True)
        embed.add_field(
            name="Strikes",
            value=f"{config.strike_limit} per {config.strike_window_days} day(s)",
            inline=True,
        )
        embed.add_field(name="Timeout", value=f"{config.timeout_seconds}s", inline=True)
        embed.add_field(
            name="Invites", value="Blocked" if config.block_invites else "Allowed", inline=True
        )
        embed.add_field(
            name="Links", value="Blocked" if config.block_links else "Allowed", inline=True
        )
        embed.add_field(name="Mention limit", value=str(config.max_mentions), inline=True)
        embed.add_field(name="Caps limit", value=f"{config.max_caps_ratio:.0%}", inline=True)
        embed.add_field(name="Line limit", value=str(config.max_newlines), inline=True)
        embed.add_field(
            name="Ignored channels",
            value=", ".join(f"<#{cid}>" for cid in sorted(config.ignored_channels)) or "None",
            inline=False,
        )
        embed.add_field(
            name="Ignored roles",
            value=", ".join(f"<@&{rid}>" for rid in sorted(config.ignored_roles)) or "None",
            inline=False,
        )
        embed.add_field(
            name=f"Blocked words ({len(words)})",
            value=truncate(", ".join(words), 900) or "None",
            inline=False,
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @tree.command(name="automod-toggle", description="Turn automod on or off.")
    @app_commands.check(staff_check)
    @app_commands.describe(enabled="True to enable automod.")
    async def automod_toggle(interaction: discord.Interaction, enabled: bool) -> None:
        await bot.db.set_automod(interaction.guild.id, enabled=enabled)
        await interaction.response.send_message(
            f"Automod is now **{'enabled' if enabled else 'disabled'}**.", ephemeral=True
        )

    group = app_commands.Group(
        name="automod-config", description="Fine tune automod.", parent=None
    )
    tree.add_command(group)

    @group.command(name="action", description="Action taken on every violation.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        action="What to do when a rule is broken.",
        timeout_seconds="Timeout length in seconds when the action is timeout.",
    )
    @app_commands.choices(
        action=[
            app_commands.Choice(name="Delete", value="delete"),
            app_commands.Choice(name="Timeout", value="timeout"),
            app_commands.Choice(name="Kick", value="kick"),
            app_commands.Choice(name="Ban", value="ban"),
        ]
    )
    async def automod_action(
        interaction: discord.Interaction,
        action: app_commands.Choice[str],
        timeout_seconds: int = 600,
    ) -> None:
        seconds = max(timeout_seconds, 30)
        await bot.db.set_automod(
            interaction.guild.id, on_violation=action.value, timeout_seconds=seconds
        )
        await interaction.response.send_message(
            f"Violations now trigger **{action.value}** (timeout {seconds}s).", ephemeral=True
        )

    @group.command(name="strike", description="Action after too many strikes.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        action="Action once the strike limit is reached.",
        limit="Strikes needed before the action fires.",
        window_days="How many days strikes are counted for.",
    )
    @app_commands.choices(
        action=[
            app_commands.Choice(name="Nothing", value="none"),
            app_commands.Choice(name="Timeout", value="timeout"),
            app_commands.Choice(name="Kick", value="kick"),
            app_commands.Choice(name="Ban", value="ban"),
        ]
    )
    async def automod_strike(
        interaction: discord.Interaction,
        action: app_commands.Choice[str],
        limit: int = 3,
        window_days: int = 7,
    ) -> None:
        limit = max(limit, 1)
        window_days = max(window_days, 1)
        await bot.db.set_automod(
            interaction.guild.id,
            strike_action=action.value,
            strike_limit=limit,
            strike_window_days=window_days,
        )
        await interaction.response.send_message(
            f"**{action.value}** now applies after {limit} strike(s) in {window_days} day(s).",
            ephemeral=True,
        )

    @group.command(name="limits", description="Set the spam thresholds.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        max_mentions="Mentions allowed per message.",
        max_caps_ratio="Share of capital letters allowed, 0 to 1.",
        min_caps_length="Only check caps on messages at least this long.",
        max_newlines="Line breaks allowed per message.",
        block_invites="Block Discord invite links.",
        block_links="Block external links.",
    )
    async def automod_limits(
        interaction: discord.Interaction,
        max_mentions: int = -1,
        max_caps_ratio: float = -1.0,
        min_caps_length: int = -1,
        max_newlines: int = -1,
        block_invites: bool | None = None,
        block_links: bool | None = None,
    ) -> None:
        updates: dict[str, Any] = {}
        if max_mentions >= 0:
            updates["max_mentions"] = max_mentions
        if 0 <= max_caps_ratio <= 1:
            updates["max_caps_ratio"] = max_caps_ratio
        if min_caps_length >= 0:
            updates["min_caps_length"] = min_caps_length
        if max_newlines >= 0:
            updates["max_newlines"] = max_newlines
        if block_invites is not None:
            updates["block_invites"] = block_invites
        if block_links is not None:
            updates["block_links"] = block_links
        if not updates:
            await interaction.response.send_message(
                "Nothing to change. Pass a value you want to set.", ephemeral=True
            )
            return
        await bot.db.set_automod(interaction.guild.id, **updates)
        await interaction.response.send_message(
            "Updated " + ", ".join(f"`{key}` to `{value}`" for key, value in updates.items()),
            ephemeral=True,
        )

    @group.command(name="word", description="Add or remove a blocked word.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        word="Word to block or allow. Characters and spaces are ignored when matching.",
        add="True to block it, False to remove it.",
    )
    async def automod_word(interaction: discord.Interaction, word: str, add: bool = True) -> None:
        clean = canonicalize(word)
        if not clean:
            await interaction.response.send_message("That word is empty.", ephemeral=True)
            return
        if add:
            await bot.db.add_blocked_word(interaction.guild.id, clean)
            message = f"Blocking `{clean}`, including spaced out and l33t spellings."
        else:
            removed = await bot.db.remove_blocked_word(interaction.guild.id, clean)
            message = f"Removed `{clean}`." if removed else f"`{clean}` was not blocked."
        await interaction.response.send_message(message, ephemeral=True)

    @group.command(name="word-clear", description="Remove every blocked word.")
    @app_commands.check(staff_check)
    async def automod_word_clear(interaction: discord.Interaction) -> None:
        removed = await bot.db.clear_blocked_words(interaction.guild.id)
        await interaction.response.send_message(f"Removed {removed} blocked word(s).", ephemeral=True)

    @group.command(name="ignore-channel", description="Exempt a channel from automod.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        target="Channel to exempt.", add="True to exempt, False to remove the exemption."
    )
    async def automod_ignore_channel(
        interaction: discord.Interaction, target: discord.abc.GuildChannel, add: bool = True
    ) -> None:
        if add:
            await bot.db.set_ignore(interaction.guild.id, "channel", target.id)
            message = f"{target.mention} is exempt from automod."
        else:
            removed = await bot.db.remove_ignore(interaction.guild.id, "channel", target.id)
            message = (
                f"{target.mention} is moderated again."
                if removed
                else f"{target.mention} was not exempt."
            )
        await interaction.response.send_message(message, ephemeral=True)

    @group.command(name="ignore-role", description="Exempt a role from automod.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        target="Role to exempt.", add="True to exempt, False to remove the exemption."
    )
    async def automod_ignore_role(
        interaction: discord.Interaction, target: discord.Role, add: bool = True
    ) -> None:
        if add:
            await bot.db.set_ignore(interaction.guild.id, "role", target.id)
            message = f"{target.mention} is exempt from automod."
        else:
            removed = await bot.db.remove_ignore(interaction.guild.id, "role", target.id)
            message = (
                f"{target.mention} is moderated again."
                if removed
                else f"{target.mention} was not exempt."
            )
        await interaction.response.send_message(message, ephemeral=True)

    @group.command(name="test", description="Run a message through the automod rules.")
    @app_commands.check(staff_check)
    @app_commands.describe(text="Text to test.")
    async def automod_test(interaction: discord.Interaction, text: str) -> None:
        config = await bot.db.get_automod(interaction.guild.id)
        violations = analyze_message(text, config, text.count("@"))
        description = (
            "\n".join(f"- {item}" for item in violations)
            if violations
            else "No violations. This message would pass."
        )
        await interaction.response.send_message(
            embed=discord.Embed(title="Automod test", description=description, color=ACCENT_COLOR),
            ephemeral=True,
        )

    @tree.command(name="applications", description="List applications.")
    @app_commands.check(staff_check)
    @app_commands.describe(status="Filter by status, or leave empty for all.")
    @app_commands.choices(
        status=[
            app_commands.Choice(name="Pending", value="pending"),
            app_commands.Choice(name="Approved", value="approved"),
            app_commands.Choice(name="Denied", value="denied"),
        ]
    )
    async def applications(
        interaction: discord.Interaction, status: app_commands.Choice[str] | None = None
    ) -> None:
        rows = await bot.db.list_applications(
            interaction.guild.id, status.value if status else None, 25
        )
        if not rows:
            await interaction.response.send_message("No applications found.", ephemeral=True)
            return
        lines = []
        for row in rows:
            label = APPLICATION_TYPES[str(row["kind"])].label
            stamp = datetime.fromtimestamp(int(row["created_at"])).strftime("%Y-%m-%d")
            link = ""
            if row["message_id"] and row["channel_id"]:
                link = (
                    f" [jump](https://discord.com/channels/{interaction.guild.id}"
                    f"/{row['channel_id']}/{row['message_id']})"
                )
            lines.append(
                f"`#{row['id']}` `{row['user_id']}` {label} - {row['status']} - {stamp}{link}"
            )
        await interaction.response.send_message(
            embed=discord.Embed(title="Applications", description="\n".join(lines), color=ACCENT_COLOR),
            ephemeral=True,
        )

    @tree.command(name="application-revoke", description="Put an application back to pending.")
    @app_commands.check(staff_check)
    @app_commands.describe(application_id="Application ID from the review channel.")
    async def application_revoke(interaction: discord.Interaction, application_id: int) -> None:
        row = await bot.db.get_application(application_id)
        if row is None or row["guild_id"] != interaction.guild.id:
            await interaction.response.send_message("Application not found.", ephemeral=True)
            return
        if not isinstance(interaction.channel, discord.TextChannel):
            await interaction.response.send_message("Use this in the review channel.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        await bot.db.set_application_status(application_id, "pending", None, "reopened")
        user = await bot.fetch_user(int(row["user_id"]))
        answers = json.loads(str(row["answers"]))
        account = await bot.db.get_roblox_account(interaction.guild.id, user.id)
        message = await interaction.channel.send(
            embed=build_application_embed(
                application_id, str(row["kind"]), user, answers, account
            ),
            view=ApplicationReviewView(bot, application_id, str(row["kind"])),
        )
        await bot.db.set_application_message(application_id, interaction.channel.id, message.id)
        await interaction.followup.send(
            f"Application #{application_id} is pending again.", ephemeral=True
        )

    @tree.command(name="warnings", description="Check or clear a member's warnings.")
    @app_commands.check(staff_check)
    @app_commands.describe(member="Member to inspect.", clear="True to delete their warnings.")
    async def warnings(
        interaction: discord.Interaction, member: discord.Member, clear: bool = False
    ) -> None:
        if clear:
            removed = await bot.db.clear_warnings(interaction.guild.id, member.id)
            await interaction.response.send_message(
                f"Cleared {removed} warning(s) for {member.mention}.", ephemeral=True
            )
            return
        rows = await bot.db.list_warnings(interaction.guild.id, member.id, 10)
        if not rows:
            await interaction.response.send_message(
                f"No warnings for {member.mention}.", ephemeral=True
            )
            return
        lines = [
            f"`{datetime.fromtimestamp(int(row['created_at'])).strftime('%Y-%m-%d %H:%M')}` "
            f"[{row['source']}] {truncate(str(row['reason']), 120)}"
            for row in rows
        ]
        await interaction.response.send_message(
            embed=discord.Embed(
                title=f"Warnings for {member}", description="\n".join(lines), color=PENDING_COLOR
            ),
            ephemeral=True,
        )

    @tree.command(
        name="verify",
        description="Verify your Roblox account with a one time code in your profile bio.",
    )
    @app_commands.describe(
        username="Your Roblox username. Optional: you can add it later with /verify again.",
    )
    async def verify(interaction: discord.Interaction, username: str | None = None) -> None:
        if interaction.guild is None:
            await interaction.response.send_message(
                "Run this in the server so I can give you the right role.", ephemeral=True
            )
            return
        guild_id = interaction.guild.id
        await interaction.response.defer(ephemeral=True)
        account = await bot.db.get_roblox_account(guild_id, interaction.user.id)
        if account is not None and account["bio_ok"]:
            await interaction.followup.send(
                embed=build_profile_embed(account), ephemeral=True
            )
            return
        try:
            session, settings = await bot.start_verification(
                guild_id, interaction.user, username
            )
        except Exception:
            log.exception("Could not start verification for %s", interaction.user.id)
            await interaction.followup.send(
                "Something went wrong on my side. Try again in a moment.", ephemeral=True
            )
            return
        embed = build_verify_embed(
            str(session["code"]),
            int(settings["code_expiry_minutes"]),
            username.strip() if username else session["username"],
        )
        view = discord.ui.View(timeout=900)
        view.add_item(RobloxVerifyButton(bot, guild_id))
        await interaction.followup.send(embed=embed, view=view, ephemeral=True)

    @tree.command(
        name="verification", description="Show the Roblox account linked to your Discord account."
    )
    async def verification(interaction: discord.Interaction) -> None:
        if interaction.guild is None:
            await interaction.response.send_message("Run this in the server.", ephemeral=True)
            return
        guild_id = interaction.guild.id
        await interaction.response.defer(ephemeral=True)
        account = await bot.db.get_roblox_account(guild_id, interaction.user.id)
        if account is None or not account["bio_ok"]:
            await interaction.followup.send(
                "You are **not verified** yet. Run `/verify` to get a code, put it in your "
                "Roblox profile bio, and press Verify.",
                ephemeral=True,
            )
            return
        await interaction.followup.send(
            embed=build_profile_embed(account), ephemeral=True
        )

    @tree.command(
        name="unlink", description="Remove the Roblox account linked to your Discord account."
    )
    async def unlink(interaction: discord.Interaction) -> None:
        if interaction.guild is None:
            await interaction.response.send_message("Run this in the server.", ephemeral=True)
            return
        guild_id = interaction.guild.id
        await interaction.response.defer(ephemeral=True)
        account = await bot.db.get_roblox_account(guild_id, interaction.user.id)
        if account is None:
            await interaction.followup.send(
                "You do not have a Roblox account linked, so there is nothing to remove.",
                ephemeral=True,
            )
            return
        settings = await bot.db.get_verify_settings(guild_id, bot.config)
        await bot.unlink_account(guild_id, interaction.user, settings)
        note = ""
        if settings.get("remove_role_on_unlink") and settings.get("role_id"):
            note = "\nI also removed your verification role."
        await interaction.followup.send(
            f"Unlinked **{account['username']}** from your Discord account.{note}\n"
            "Run `/verify` whenever you want to link again.",
            ephemeral=True,
        )

    @tree.command(name="roblox", description="Show the Roblox verification setup and records.")
    @app_commands.check(staff_check)
    async def roblox_status(interaction: discord.Interaction) -> None:
        settings = await bot.db.get_guild_settings(interaction.guild.id)
        records = await bot.db.list_roblox_accounts(interaction.guild.id, 15)
        embed = discord.Embed(title="Roblox verification", color=UNVERIFIED_COLOR)
        embed.add_field(
            name="How members verify",
            value="Run `/verify username:TheirRobloxName` in the server.",
            inline=False,
        )
        embed.add_field(
            name="Bio rule",
            value=BIO_RULES.get(str(settings["roblox_bio_rule"]), "unknown"),
            inline=False,
        )
        embed.add_field(
            name="Requirement",
            value={
                "off": "Not required to apply",
                "any": "Any Roblox account linked",
                "profile": "Username and bio check required",
                "oauth": "Roblox sign in required",
            }.get(str(settings["roblox_requirement"]), "off"),
            inline=True,
        )
        embed.add_field(
            name="Minimum account age",
            value=f"{settings['roblox_min_account_age_days']} day(s)",
            inline=True,
        )
        if bot.config.roblox_oauth_ready:
            embed.add_field(
                name="Roblox sign in",
                value=f"Available, redirect `{bot.config.roblox_redirect_uri}`",
                inline=False,
            )
        else:
            embed.add_field(
                name="Roblox sign in",
                value=(
                    "Not set up, which is fine. Username and bio checks need nothing extra. "
                    "Set ROBLOX_CLIENT_ID, ROBLOX_CLIENT_SECRET and ROBLOX_REDIRECT_URI if you "
                    "want members to sign in with Roblox instead."
                ),
                inline=False,
            )
        if records:
            lines = [f"<@{row['discord_user_id']}> - {roblox_summary(row)}" for row in records]
            embed.add_field(name=f"Checked ({len(records)} shown)", value="\n".join(lines), inline=False)
        else:
            embed.add_field(name="Checked", value="Nobody yet.", inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    roblox_group = app_commands.Group(
        name="roblox-config", description="Roblox verification settings.", parent=None
    )
    tree.add_command(roblox_group)

    @roblox_group.command(name="requirement", description="Who must verify a Roblox account.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        mode=(
            "off = anyone can apply, any = any Roblox account, profile = username and bio "
            "check, oauth = only a real Roblox sign in."
        )
    )
    @app_commands.choices(
        mode=[
            app_commands.Choice(name="Off", value="off"),
            app_commands.Choice(name="Any account", value="any"),
            app_commands.Choice(name="Username and bio", value="profile"),
            app_commands.Choice(name="Roblox sign in", value="oauth"),
        ]
    )
    async def roblox_requirement(
        interaction: discord.Interaction, mode: app_commands.Choice[str]
    ) -> None:
        await bot.db.set_roblox_requirement(interaction.guild.id, mode.value)
        await interaction.response.send_message(
            f"Roblox verification is now **{mode.value}**. Re-post the panel with `/panel` so "
            "members see the new rule.",
            ephemeral=True,
        )

    @roblox_group.command(name="bio-rule", description="What the Roblox bio has to contain.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        rule=(
            "off = any account, code = the bio must contain the code the bot gives them, "
            "discord = the bio must contain their Discord name."
        )
    )
    @app_commands.choices(
        rule=[
            app_commands.Choice(name="Off", value="off"),
            app_commands.Choice(name="Code in bio", value="code"),
            app_commands.Choice(name="Discord name in bio", value="discord"),
        ]
    )
    async def roblox_bio_rule(
        interaction: discord.Interaction, rule: app_commands.Choice[str]
    ) -> None:
        await bot.db.set_roblox_bio_rule(interaction.guild.id, rule.value)
        await interaction.response.send_message(
            f"Bio rule is now **{rule.value}**: {BIO_RULES[rule.value]}", ephemeral=True
        )

    @roblox_group.command(name="min-age", description="Minimum Roblox account age to apply.")
    @app_commands.check(staff_check)
    @app_commands.describe(days="Days the Roblox account must be old, 0 for no minimum.")
    async def roblox_min_age(interaction: discord.Interaction, days: int) -> None:
        await bot.db.set_roblox_min_age(interaction.guild.id, days)
        await interaction.response.send_message(
            f"Minimum Roblox account age is now {max(days, 0)} day(s).", ephemeral=True
        )

    @roblox_group.command(name="check", description="Look up one member's Roblox account.")
    @app_commands.check(staff_check)
    @app_commands.describe(member="Member to look up.")
    async def roblox_check(interaction: discord.Interaction, member: discord.Member) -> None:
        account = await bot.db.get_roblox_account(interaction.guild.id, member.id)
        settings = await bot.db.get_guild_settings(interaction.guild.id)
        if account is None:
            description = f"{member.mention} has no Roblox account checked yet."
            embed = discord.Embed(
                title="Roblox account", description=description, color=0x6B7280
            )
        else:
            stamp = datetime.fromtimestamp(int(account["verified_at"])).strftime("%Y-%m-%d %H:%M")
            embed = build_profile_embed(account)
            embed.title = f"Roblox account for {member}"
            embed.set_footer(text=f"Checked {stamp} UTC | counts for this server: "
                                 f"{'yes' if bot.roblox_requirement_met(str(settings['roblox_requirement']), account) else 'no'}")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @roblox_group.command(name="override", description="Mark a member as verified yourself.")
    @app_commands.check(staff_check)
    @app_commands.describe(
        member="Member to mark.", roblox_username="Their Roblox username, or leave empty."
    )
    async def roblox_override(
        interaction: discord.Interaction, member: discord.Member, roblox_username: str = ""
    ) -> None:
        await interaction.response.defer(ephemeral=True)
        if roblox_username.strip():
            try:
                profile = await bot.roblox.resolve_username(roblox_username)
            except RobloxError as error:
                await interaction.followup.send(str(error), ephemeral=True)
                return
            problem = await bot.store_roblox_account(
                guild_id=interaction.guild.id,
                user=member,
                roblox_user_id=int(profile.get("id") or 0),
                username=str(profile.get("name") or roblox_username),
                display_name=str(profile.get("displayName") or roblox_username),
                method="manual",
                age_days=None,
                email_verified=False,
            )
            if problem is not None:
                await interaction.followup.send(f"That did not work: {problem}", ephemeral=True)
                return
        else:
            await bot.db.save_roblox_account(
                interaction.guild.id,
                member.id,
                0,
                f"manual-{member.id}",
                member.display_name,
                "manual",
                None,
                False,
            )
        account = await bot.db.get_roblox_account(interaction.guild.id, member.id)
        await interaction.followup.send(
            f"{member.mention} is now marked as verified.\n{roblox_summary(account)}",
            ephemeral=True,
        )

    @roblox_group.command(name="unlink", description="Remove a member's Roblox account.")
    @app_commands.check(staff_check)
    @app_commands.describe(member="Member to unlink.")
    async def roblox_unlink(interaction: discord.Interaction, member: discord.Member) -> None:
        await interaction.response.defer(ephemeral=True)
        settings = await bot.db.get_verify_settings(interaction.guild.id, bot.config)
        removed = await bot.unlink_account(interaction.guild.id, member, settings)
        await interaction.followup.send(
            f"Removed the Roblox link for {member.mention}." if removed
            else f"{member.mention} had no Roblox account linked.",
            ephemeral=True,
        )

    verify_admin = app_commands.Group(
        name="verify-admin",
        description="Manage Roblox verification.",
        parent=None,
        guild=False,
    )
    tree.add_command(verify_admin)

    @verify_admin.command(name="check", description="Show a member's linked Roblox account.")
    @app_commands.check(staff_check)
    @app_commands.describe(user="The member to look up.")
    async def verify_admin_check(interaction: discord.Interaction, user: discord.Member) -> None:
        guild_id = interaction.guild.id
        account = await bot.db.get_roblox_account(guild_id, user.id)
        session = await bot.db.get_session(guild_id, user.id)
        settings = await bot.db.get_guild_settings(guild_id)
        if account is None:
            description = f"{user.mention} has no Roblox account linked."
            if session is not None and bot.db.session_is_live(
                session, int(await bot.db.get_verify_settings(guild_id, bot.config)["code_expiry_minutes"])
            ):
                description += f"\nThey have a pending code: `{session['code']}`."
            embed = discord.Embed(
                title="Roblox verification", description=description, color=0x6B7280
            )
        else:
            stamp = datetime.fromtimestamp(int(account["verified_at"])).strftime("%Y-%m-%d %H:%M")
            embed = build_profile_embed(account)
            embed.title = f"Roblox verification for {user}"
            embed.set_footer(
                text=f"Verified {stamp} UTC | counts for this server: "
                f"{'yes' if bot.roblox_requirement_met(str(settings['roblox_requirement']), account) else 'no'}"
            )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @verify_admin.command(name="unlink", description="Remove a member's verification.")
    @app_commands.check(staff_check)
    @app_commands.describe(user="The member to unverify.")
    async def verify_admin_unlink(interaction: discord.Interaction, user: discord.Member) -> None:
        await interaction.response.defer(ephemeral=True)
        guild_id = interaction.guild.id
        account = await bot.db.get_roblox_account(guild_id, user.id)
        settings = await bot.db.get_verify_settings(guild_id, bot.config)
        removed = await bot.unlink_account(guild_id, user, settings)
        if removed:
            log.info("Verification removed for %s by %s", user.id, interaction.user.id)
        await interaction.followup.send(
            f"Removed the verification for {user.mention} (was {account['username']})."
            if removed
            else f"{user.mention} was not verified.",
            ephemeral=True,
        )

    @verify_admin.command(name="config", description="Show or change verification settings.")
    @app_commands.check(admin_check)
    @app_commands.describe(
        role="Verification role to give on success, or 'none' to skip roles.",
        code_expiry="Minutes a verification code stays valid.",
        max_attempts="How many times a member may press Verify per code.",
        cooldown="Seconds between attempts for one member.",
        allow_transfer="Allow a Roblox account to move to a different Discord account.",
        remove_role="Remove the verification role when someone unlinks.",
    )
    @app_commands.choices(
        remove_role=[
            app_commands.Choice(name="Keep the role", value="keep"),
            app_commands.Choice(name="Remove the role", value="remove"),
        ],
        allow_transfer=[
            app_commands.Choice(name="No, block transfers", value="block"),
            app_commands.Choice(name="Yes, allow transfers", value="allow"),
        ],
    )
    async def verify_admin_config(
        interaction: discord.Interaction,
        role: str | None = None,
        code_expiry: int | None = None,
        max_attempts: int | None = None,
        cooldown: int | None = None,
        allow_transfer: app_commands.Choice[str] | None = None,
        remove_role: app_commands.Choice[str] | None = None,
    ) -> None:
        guild_id = interaction.guild.id
        updates: dict[str, Any] = {}
        if role is not None:
            if role.strip().lower() in {"none", "off", "clear"}:
                updates["role_id"] = 0
            elif role.strip().isdigit():
                updates["role_id"] = int(role.strip())
            else:
                await interaction.response.send_message(
                    "Give a role ID, or the word `none` to stop giving a role.", ephemeral=True
                )
                return
        if code_expiry is not None:
            updates["code_expiry_minutes"] = max(code_expiry, 1)
        if max_attempts is not None:
            updates["max_attempts"] = max(max_attempts, 1)
        if cooldown is not None:
            updates["cooldown_seconds"] = max(cooldown, 0)
        if allow_transfer is not None:
            updates["allow_transfer"] = 1 if allow_transfer.value == "allow" else 0
        if remove_role is not None:
            updates["remove_role_on_unlink"] = 1 if remove_role.value == "remove" else 0
        if updates:
            await bot.db.set_verify_settings(guild_id, **updates)
        settings = await bot.db.get_verify_settings(guild_id, bot.config)
        role_id = settings.get("role_id")
        if role_id:
            role_obj = interaction.guild.get_role(int(role_id))
            role_text = f"{role_obj.mention} (`{role_id}`)" if role_obj else f"`{role_id}` (missing)"
        else:
            role_text = "none, no role is given"
        embed = discord.Embed(
            title="Verification settings",
            color=ACCENT_COLOR,
            fields=[
                discord.EmbedField(name="Verification role", value=role_text, inline=False),
                discord.EmbedField(
                    name="Code expiry",
                    value=f"{settings['code_expiry_minutes']} minute(s)",
                    inline=True,
                ),
                discord.EmbedField(
                    name="Max attempts", value=str(settings["max_attempts"]), inline=True
                ),
                discord.EmbedField(
                    name="Cooldown", value=f"{settings['cooldown_seconds']} second(s)", inline=True
                ),
                discord.EmbedField(
                    name="Roblox transfers",
                    value="allowed" if settings["allow_transfer"] else "blocked",
                    inline=True,
                ),
                discord.EmbedField(
                    name="Role on unlink",
                    value="removed" if settings["remove_role_on_unlink"] else "kept",
                    inline=True,
                ),
            ],
        )
        if updates:
            embed.description = "Saved. Members pick up the new code rules on their next `/verify`."
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @verify_admin.command(name="codes", description="List members with a pending code.")
    @app_commands.check(staff_check)
    async def verify_admin_codes(interaction: discord.Interaction) -> None:
        guild_id = interaction.guild.id
        settings = await bot.db.get_verify_settings(guild_id, bot.config)
        expiry = int(settings["code_expiry_minutes"])
        rows = await bot.db.fetch_all(
            "SELECT s.discord_user_id, s.code, s.username, s.attempts, s.created_at"
            " FROM verify_sessions s WHERE s.guild_id = ? AND s.consumed_at IS NULL"
            " ORDER BY s.created_at DESC LIMIT 50",
            (guild_id,),
        )
        live = [r for r in rows if now_ts() - int(r["created_at"]) < expiry * 60]
        if not live:
            await interaction.response.send_message(
                "No members have a pending verification code.", ephemeral=True
            )
            return
        lines = [
            f"<@{row['discord_user_id']}> - `{row['code']}`"
            + (f" for `{row['username']}`" if row["username"] else "")
            + f" ({row['attempts']} attempt(s))"
            for row in live
        ]
        await interaction.response.send_message(
            embed=discord.Embed(
                title=f"Pending codes ({len(live)})",
                description="\n".join(lines),
                color=PENDING_COLOR,
            ),
            ephemeral=True,
        )

    @roblox_group.command(name="unlink-all", description="Remove every Roblox link in this server.")
    @app_commands.check(admin_check)
    async def roblox_unlink_all(interaction: discord.Interaction) -> None:
        records = await bot.db.list_roblox_accounts(interaction.guild.id, 1000)
        for row in records:
            await bot.db.delete_roblox_account(interaction.guild.id, int(row["discord_user_id"]))
        await interaction.response.send_message(f"Unlinked {len(records)} member(s).", ephemeral=True)

    @tree.command(name="sync", description="Re-sync slash commands to this server.")
    @app_commands.check(admin_check)
    async def sync(interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        await bot.sync_commands()
        await interaction.followup.send("Commands synced.", ephemeral=True)


def register_events(bot: LATCManagement) -> None:
    @bot.event
    async def on_message(message: discord.Message) -> None:
        try:
            await bot.handle_automod(message)
        except Exception:
            log.exception("Automod failed on message %s", getattr(message, "id", "?"))

    @bot.event
    async def on_message_edit(before: discord.Message, after: discord.Message) -> None:
        if before.content == after.content:
            return
        try:
            await bot.handle_automod(after)
        except Exception:
            log.exception("Automod failed on edit %s", getattr(after, "id", "?"))

    @bot.tree.error
    async def on_command_error(
        interaction: discord.Interaction, error: app_commands.AppCommandError
    ) -> None:
        if isinstance(error, app_commands.CheckFailure):
            message = "You need the staff role or Manage Messages to use that."
        elif isinstance(error, app_commands.MissingPermissions):
            message = "You are missing permissions for that."
        else:
            log.error(
                "Command error in %s: %s",
                getattr(interaction.command, "qualified_name", "?"),
                error,
            )
            message = "Something went wrong. The bot log has the details."
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    logging.getLogger("discord.gateway").setLevel(logging.WARNING)
    load_env_file(BASE_DIR / ".env")

    config = Config.from_env()
    db = Database(config.database_path)
    bot = LATCManagement(config, db)
    register_events(bot)
    try:
        bot.run(config.token, log_handler=None)
    finally:
        db.close()


if __name__ == "__main__":
    main()
