import asyncio
import json
import pathlib
import tempfile
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
    """Applications are owned by the website API. The bot only reads the shared
    web_applications table to post reviews; it must not own the old panel flow."""

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

    def test_database_has_no_legacy_application_methods(self):
        for removed in (
            "create_application",
            "set_application_message",
            "set_application_status",
            "pending_for_user",
            "list_applications",
            "get_panel_message_id",
            "set_panel_message_id",
            "restorable_applications",
        ):
            self.assertFalse(hasattr(Database, removed), removed)

    def test_review_methods_exist(self):
        for kept in (
            "list_pending_applications",
            "mark_application_notified",
            "list_open_application_reviews",
            "get_application",
            "decide_application",
        ):
            self.assertTrue(hasattr(Database, kept), kept)
        self.assertEqual(Config.__dataclass_fields__["application_review_channel_id"].type, "int | None")

    def test_bot_keeps_roblox_verification(self):
        """Removing applications must not take Roblox verification with it."""
        import main

        for kept in ("RobloxVerifyButton", "build_verify_embed", "build_profile_embed"):
            self.assertTrue(hasattr(main, kept), kept)
        self.assertTrue(hasattr(main.LATCManagement, "attempt_verification"))
        self.assertTrue(hasattr(main.LATCManagement, "application_review_loop"))
        self.assertTrue(hasattr(main.LATCManagement, "notify_application_outcome"))


class ApplicationReviewFlowTests(unittest.TestCase):
    def test_review_cycle_on_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(pathlib.Path(directory) / "test.db")
            payload = json.dumps({"robloxUsername": "pilot_one", "motivation": "love flying"})

            async def exercise():
                await db.execute(
                    "CREATE TABLE IF NOT EXISTS web_applications ("
                    " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                    " role TEXT NOT NULL,"
                    " discord_user_id INTEGER NOT NULL,"
                    " discord_username TEXT NOT NULL,"
                    " payload TEXT NOT NULL,"
                    " status TEXT NOT NULL DEFAULT 'pending',"
                    " created_at INTEGER NOT NULL"
                    ")"
                )
                await db.execute(
                    "INSERT INTO web_applications (role, discord_user_id, discord_username,"
                    " payload, status, created_at) VALUES ('pilot', 111, 'pilot_one', ?, 'pending', 1000)",
                    (payload,),
                )
                await db.execute(
                    "INSERT INTO web_applications (role, discord_user_id, discord_username,"
                    " payload, status, created_at) VALUES ('pilot', 222, 'pilot_two', ?, 'pending', 1001)",
                    (payload,),
                )
                await db.execute(
                    "INSERT INTO web_applications (role, discord_user_id, discord_username,"
                    " payload, status, created_at) VALUES ('atc', 333, 'atc_one', ?, 'approved', 1002)",
                    (payload,),
                )

                first = await db.fetch_one("SELECT id FROM web_applications ORDER BY id LIMIT 1")
                notified_id = int(
                    (await db.fetch_one("SELECT id FROM web_applications WHERE discord_user_id = 222"))["id"]
                )
                first_id = int(first["id"])

                await db.mark_application_notified(notified_id, 5000)

                pending = await db.list_pending_applications(20)
                self.assertEqual([int(row["id"]) for row in pending], [first_id])

                row = await db.get_application(first_id)
                self.assertIsNotNone(row)
                self.assertEqual(row["status"], "pending")

                self.assertEqual(await db.decide_application(first_id, "approved"), 1)
                self.assertEqual((await db.get_application(first_id))["status"], "approved")
                self.assertEqual(await db.decide_application(first_id, "rejected"), 0)

                reopened = [int(row["app_id"]) for row in await db.list_open_application_reviews(200)]
                self.assertNotIn(first_id, reopened)
                self.assertIn(notified_id, reopened)

            try:
                asyncio.run(exercise())
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()