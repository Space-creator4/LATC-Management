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


class AtcPanelFeatureTests(unittest.TestCase):
    def test_schema_has_atc_panel_tables(self):
        for table in ("atc_claims", "atc_panels", "atis_entries"):
            self.assertIn(table, SCHEMA, table)

    def test_config_has_atc_fields(self):
        fields = Config.__dataclass_fields__
        for kept in (
            "atc_category_id",
            "atc_panel_channel_id",
            "atc_atis_channel_id",
        ):
            self.assertIn(kept, fields, kept)
            self.assertEqual(fields[kept].type, "int | None")

    def test_postgres_conversion_keeps_on_conflict_upsert(self):
        sql = (
            "INSERT INTO atc_claims (guild_id, channel_id, user_id, claimed_at)"
            " VALUES (?, ?, ?, ?) ON CONFLICT (guild_id, channel_id)"
            " DO UPDATE SET user_id = ?, claimed_at = ?"
        )
        self.assertEqual(
            Database._postgres_sql(sql),
            "INSERT INTO atc_claims (guild_id, channel_id, user_id, claimed_at)"
            " VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, channel_id)"
            " DO UPDATE SET user_id = $5, claimed_at = $6",
        )

    def test_panel_message_and_atis_roundtrip(self):
        import main

        for kept in (
            "ClaimAtcButton",
            "AtcClaimView",
            "AtisUpdateButton",
            "AtisUpdateModal",
            "AtisView",
            "build_atc_panel_embed",
            "build_atis_embed",
        ):
            self.assertTrue(hasattr(main, kept), kept)
        self.assertTrue(hasattr(main.LATCManagement, "refresh_atc_panel"))
        self.assertTrue(hasattr(main.LATCManagement, "refresh_atis"))
        self.assertTrue(hasattr(main.LATCManagement, "publish_atc_panel"))

        with tempfile.TemporaryDirectory() as directory:
            db = Database(pathlib.Path(directory) / "test.db")

            async def exercise():
                self.assertIsNone(await db.get_atc_panel_message(10))
                await db.set_atc_panel_message(10, 555)
                self.assertEqual(await db.get_atc_panel_message(10), 555)
                await db.set_atc_panel_message(10, 777)
                self.assertEqual(await db.get_atc_panel_message(10), 777)

                await db.set_atis_entry(10, 100, 900, "runway 09 ILS\nDEP RWY 8 ARR RWY 8", 1)
                entry = await db.get_atis_entry(10, 100)
                self.assertIsNotNone(entry)
                self.assertEqual(entry["message_id"], 900)
                self.assertEqual(entry["content"], "runway 09 ILS\nDEP RWY 8 ARR RWY 8")
                await db.set_atis_entry(10, 100, 901, "ISAU ATIS INFO J...", 2)
                entry = await db.get_atis_entry(10, 100)
                self.assertEqual(entry["message_id"], 901)
                self.assertEqual(entry["content"], "ISAU ATIS INFO J...")
                self.assertEqual(entry["updated_by"], 2)
                self.assertEqual(len(await db.list_atis_entries(10)), 1)

            try:
                asyncio.run(exercise())
            finally:
                db.close()

    def test_claim_release_and_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(pathlib.Path(directory) / "test.db")

            async def exercise():
                self.assertIsNone(await db.claim_atc_position(10, 100, 1))
                self.assertEqual(await db.atc_claim_for(10, 100), 1)
                self.assertEqual(await db.claim_atc_position(10, 100, 1), None)
                self.assertEqual(await db.claim_atc_position(10, 100, 2), 1)
                self.assertEqual(await db.atc_claim_for(10, 100), 1)
                self.assertEqual(len(await db.list_atc_claims(10)), 1)
                self.assertTrue(await db.release_atc_claim(10, 100))
                self.assertFalse(await db.release_atc_claim(10, 100))
                self.assertIsNone(await db.atc_claim_for(10, 100))

            try:
                asyncio.run(exercise())
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()