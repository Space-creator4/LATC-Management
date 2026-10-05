"use strict";

const { Pool } = require("pg");

/**
 * Postgres access.
 *
 * The website API shares the Neon database with the Discord bot, so it only ever
 * creates the tables it owns and never touches the bot's. Every statement is
 * CREATE TABLE IF NOT EXISTS, which keeps booting this service safe against a
 * database the bot has already migrated.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS web_sessions (
    id TEXT PRIMARY KEY,
    discord_user_id BIGINT NOT NULL,
    discord_username TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    guild_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS web_sessions_expiry ON web_sessions (expires_at);

CREATE TABLE IF NOT EXISTS web_applications (
    id BIGSERIAL PRIMARY KEY,
    role TEXT NOT NULL,
    discord_user_id BIGINT NOT NULL,
    discord_username TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS web_applications_queue ON web_applications (status, created_at);

CREATE TABLE IF NOT EXISTS web_queue_entries (
    id BIGSERIAL PRIMARY KEY,
    discord_user_id BIGINT NOT NULL,
    discord_username TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS web_queue_entries_active
    ON web_queue_entries (discord_user_id)
    WHERE status IN ('pending', 'approved');
`;

/**
 * Small wrapper so route handlers never touch the pool directly and so tests can
 * pass a stub with the same four methods.
 */
class Store {
    constructor(connectionString) {
        this.pool = new Pool({
            connectionString,
            max: 5,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
            ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }
        });
        this.pool.on("error", (error) => {
            console.error("[db] idle client error", error.message);
        });
    }

    async migrate() {
        await this.pool.query(SCHEMA);
    }

    async query(text, params) {
        return this.pool.query(text, params);
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = { Store, SCHEMA };
