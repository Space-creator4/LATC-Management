import pathlib
import unittest

from main import SCHEMA, Config, Database

ROOT = pathlib.Path(__file__).resolve().parents[1]


class NeonDbConfigTests(unittest.TestCase):
    def test_requirements_include_asyncpg(self):
        text = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("asyncpg", text.lower())

    def test_env_example_documents_database_url(self):
        text = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("DATABASE_URL", text)

    def test_postgres_placeholder_conversion(self):
        sql = "SELECT * FROM table WHERE guild_id = ? AND user_id = ?"
        self.assertEqual(Database._postgres_sql(sql), "SELECT * FROM table WHERE guild_id = $1 AND user_id = $2")
        insert = "INSERT OR IGNORE INTO automod_config (guild_id) VALUES (?)"
        self.assertEqual(
            Database._postgres_sql(insert),
            "INSERT INTO automod_config (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
        )
        self.assertEqual(Database._postgres_rowcount("INSERT 0 1"), 1)
        self.assertEqual(Database._postgres_rowcount("UPDATE 3"), 3)


class WebsiteHandoffTests(unittest.TestCase):
    """Applications moved to the website, so the bot must not own them any more."""

    def test_schema_has_no_application_table(self):
        self.assertNotIn("applications", SCHEMA)
        self.assertNotIn("panel_message_id", SCHEMA)

    def test_config_has_no_application_fields(self):
        fields = set(Config.__dataclass_fields__)
        for removed in (
            "panel_channel_id",
            "review_channel_id",
            "pilot_role_id",
            "atc_role_id",
        ):
            self.assertNotIn(removed, fields)

    def test_database_has_no_application_methods(self):
        for removed in (
            "create_application",
            "set_application_message",
            "set_application_status",
            "get_application",
            "pending_for_user",
            "list_applications",
            "get_panel_message_id",
            "set_panel_message_id",
            "restorable_applications",
        ):
            self.assertFalse(hasattr(Database, removed), removed)

    def test_bot_keeps_roblox_verification(self):
        """Removing applications must not take Roblox verification with it."""
        import main

        for kept in ("RobloxVerifyButton", "build_verify_embed", "build_profile_embed"):
            self.assertTrue(hasattr(main, kept), kept)
        self.assertTrue(hasattr(main.LATCManagement, "attempt_verification"))


if __name__ == "__main__":
    unittest.main()