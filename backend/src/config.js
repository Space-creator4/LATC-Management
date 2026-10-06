"use strict";

/**
 * Loads .env into process.env if there is one, without overwriting anything the
 * environment already provides.
 *
 * Render injects its dashboard variables into the environment directly, so this
 * does nothing in production and `.env` is absent anyway. It exists so that a
 * local `npm start` behaves like the deployed service instead of failing with a
 * confusing "DATABASE_URL is not set". Written by hand rather than pulled from
 * npm to keep the dependency list to the three packages actually needed.
 *
 * Values already set win, so `SESSION_SECRET=... npm start` overrides the file.
 */
function loadDotEnv(file) {
    const fs = require("fs");
    const path = require("path");

    const target = file || path.resolve(__dirname, "..", ".env");

    if (!fs.existsSync(target)) {
        return false;
    }

    for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        const equals = trimmed.indexOf("=");

        if (equals === -1) {
            continue;
        }

        const key = trimmed.slice(0, equals).trim();

        if (!key || key in process.env) {
            continue;
        }

        let value = trimmed.slice(equals + 1).trim();

        /* Strip a matching pair of surrounding quotes, which people add to
           values containing spaces or # without thinking about it. */
        if (value.length > 1 && value[0] === '"' && value[value.length - 1] === '"') {
            value = value.slice(1, -1);
        } else if (value.length > 1 && value[0] === "'" && value[value.length - 1] === "'") {
            value = value.slice(1, -1);
        }

        process.env[key] = value;
    }

    return true;
}

loadDotEnv();

/**
 * Central configuration, read once from the environment at boot.
 *
 * Nothing in this file has a default for a secret. If a required value is
 * missing the process refuses to start, because a half-configured service is
 * worse than one that is visibly down: it would otherwise accept applications
 * it cannot store, or hand out invites to nobody.
 */

/**
 * Readers below take `env` explicitly rather than reaching for process.env, so
 * loadConfig(env) really reads the object it was given. That is what lets the
 * tests build a config without mutating the process environment.
 */
function required(env, name) {
    const value = (env[name] || "").trim();

    if (!value) {
        throw new Error(
            `${name} is not set. Copy .env.example to .env and fill it in, or set it in the Render dashboard.`
        );
    }

    return value;
}

function optional(env, name, fallback = "") {
    const value = (env[name] || "").trim();
    return value || fallback;
}

function number(env, name, fallback) {
    const raw = optional(env, name);

    if (!raw) {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isFinite(value)) {
        throw new Error(`${name} must be a number, got "${raw}".`);
    }

    return value;
}

function bool(env, name, fallback) {
    const raw = optional(env, name).toLowerCase();

    if (!raw) {
        return fallback;
    }

    return raw === "1" || raw === "true" || raw === "yes";
}

function snowflake(env, name, fallback) {
    const raw = optional(env, name);

    if (!raw) {
        return fallback;
    }

    if (!/^\d{15,25}$/.test(raw)) {
        throw new Error(`${name} must be a Discord snowflake (15-25 digits), got "${raw}".`);
    }

    return raw;
}

/** Builds the config object. Exported as a function rather than a constant so
 *  tests can build a config without mutating process.env. */
function loadConfig(env = process.env) {
    const nodeEnv = optional(env, "NODE_ENV", "development");
    const isProduction = nodeEnv === "production";

    return {
        nodeEnv,
        isProduction,
        port: number(env, "PORT", 3000),

        /**
         * Postgres connection string. The bot already runs against Neon, so this
         * points at the same database and shares the schema created there.
         */
        databaseUrl: required(env, "DATABASE_URL"),

        /**
         * Comma separated list of browser origins allowed to send credentialed
         * requests. These are website origins, never this API's own origin.
         *
         * The first entry is also where Discord sends the browser back to after
         * a successful login, so the live site is the default in production.
         * On a laptop the default is the local static server instead, which is
         * why the choice depends on NODE_ENV rather than being one constant.
         */
        allowedOrigins: optional(
            env,
            "ALLOWED_ORIGINS",
            isProduction
                ? "https://latcm.co.uk,https://www.latcm.co.uk"
                : "http://localhost:8000,http://127.0.0.1:8000"
        )
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),

        discord: {
            clientId: required(env, "DISCORD_CLIENT_ID"),
            /**
             * The client secret never leaves the server. It must not be put in
             * assets/js/config.js or any other file the browser can read.
             */
            clientSecret: required(env, "DISCORD_CLIENT_SECRET"),
            /**
             * Bot token used only for reading member roles server side. It is
             * separate from DISCORD_CLIENT_SECRET so one can be rotated without
             * touching the other.
             */
            botToken: optional(env, "DISCORD_BOT_TOKEN"),
            guildId: snowflake(env, "DISCORD_GUILD_ID", null),
            pilotRoleId: snowflake(env, "PILOT_ROLE_ID", null),
            atcRoleId: snowflake(env, "ATC_ROLE_ID", null),
            staffRoleId: snowflake(env, "STAFF_ROLE_ID", null),
            /**
             * Redirect URI registered in the Discord developer portal. Must
             * match exactly, including trailing slash.
             */
            redirectUri: optional(
                env,
                "DISCORD_REDIRECT_URI",
                isProduction ? "" : "http://localhost:3000/auth/discord/callback"
            )
        },

        session: {
            /**
             * Signs the session cookie. Rotating this logs everyone out.
             */
            secret: required(env, "SESSION_SECRET"),
            cookieName: optional(env, "SESSION_COOKIE_NAME", "latc_session"),
            maxAgeDays: number(env, "SESSION_MAX_AGE_DAYS", 30),
            /**
             * SESSION_SECURE defaults to true in production so the cookie is
             * only sent over HTTPS, which Render provides.
             */
            secure: bool(env, "SESSION_SECURE", isProduction)
        },

        /**
         * The Discord bot, run as a child process by this same service.
         *
         * Two names exist for the token because the bot predates the API and
         * called it DISCORD_TOKEN while the API calls it DISCORD_BOT_TOKEN.
         * Both are accepted and the supervisor maps them, so a single value in
         * the Render dashboard drives both halves.
         */
        bot: {
            enabled: bool(env, "BOT_ENABLED", true),
            token: optional(env, "DISCORD_TOKEN") || optional(env, "DISCORD_BOT_TOKEN"),
            /**
             * Interpreter used to launch bot/main.py. Left empty the supervisor
             * probes for python3, then python, then py, which is what makes one
             * render.yaml work on Linux and still start on a Windows laptop.
             */
            pythonBin: optional(env, "PYTHON_BIN"),
            /** Passed to the child so the bot's own .env lookup is unambiguous. */
            directory: optional(env, "BOT_DIRECTORY")
        },

        applications: {
            /**
             * Staff intake is closed. Kept as a switch so it can be reopened
             * from the environment instead of a deploy of new code.
             */
            staffOpen: bool(env, "APPLICATIONS_STAFF_OPEN", false),
            /**
             * ATC intake requires an accepted pilot, checked against the Discord
             * pilot role rather than trusting the client.
             */
            atcRequiresPilot: bool(env, "APPLICATIONS_ATC_REQUIRES_PILOT", true)
        },

        queue: {
            /**
             * The private server invite. It is stored here and returned by the
             * API only after a queue entry is approved. It must never be written
             * into Website/assets, because those files are public.
             */
            privateInviteUrl: required(env, "PRIVATE_INVITE_URL"),
            /**
             * Auto approval matches the decision that joining the queue and
             * accepting the rules is the whole gate. Set to false to hold entries
             * for manual approval instead.
             */
            autoApprove: bool(env, "QUEUE_AUTO_APPROVE", true)
        }
    };
}

module.exports = { loadConfig };
