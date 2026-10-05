"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const { loadConfig } = require("./config");
const { Store } = require("./db");
const { sessionMiddleware } = require("./lib/session");
const { createAuthRouter } = require("./routes/auth");
const { createApplicationsRouter } = require("./routes/applications");
const { createQueueRouter } = require("./routes/queue");
const { createRadarRouter } = require("./routes/radar");
const { loadSchema } = require("./lib/schemas");

/**
 * Builds the Express app without starting a listener, so tests can drive it with
 * supertest style calls on an ephemeral port.
 */
function createApp({ config, store }) {
    const app = express();

    app.disable("x-powered-by");
    app.set("trust proxy", 1);

    app.use(express.json({ limit: "64kb" }));
    app.use(cookieParser());

    /*
     * Credentials are sent on every call from the browser, so a wildcard origin is
     * not an option: it is rejected by the browser and would be a security hole if
     * it were not. Only configured origins get an allow header.
     */
    app.use((req, res, next) => {
        const origin = req.headers.origin;

        if (origin && config.allowedOrigins.includes(origin)) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
            res.setHeader("Vary", "Origin");
        }

        if (req.method === "OPTIONS") {
            return res.sendStatus(origin && config.allowedOrigins.includes(origin) ? 204 : 403);
        }

        return next();
    });

    const session = sessionMiddleware({ store, config });

    // Attach the store to each request so route handlers stay dependency free.
    app.use((req, res, next) => {
        req.store = store;
        return session(req, res, next);
    });

    app.get("/health", async (req, res) => {
        try {
            await store.query("SELECT 1");
            res.json({ ok: true, uptime: Math.round(process.uptime()) });
        } catch (error) {
            res.status(503).json({ ok: false, error: "database_unreachable" });
        }
    });

    /**
     * Question sets for the site, served from the same JSON the server validates
     * against. Lets the frontend render forms without duplicating the schema.
     */
    app.get("/api/question-sets", (req, res) => {
        try {
            const roles = ["pilot", "atc", "staff"];
            const sets = {};

            for (const role of roles) {
                sets[role] = loadSchema(role);
            }

            res.json({ sets });
        } catch (error) {
            res.status(500).json({ error: "question_sets_unavailable" });
        }
    });

    app.get("/api/config", (req, res) => {
        res.json({
            applications: {
                pilot: true,
                atc: config.applications.atcRequiresPilot ? "pilots_only" : true,
                staff: config.applications.staffOpen
            },
            queue: { autoApprove: config.queue.autoApprove }
        });
    });

    app.use("/auth", createAuthRouter({ config }));
    app.use("/api/applications", createApplicationsRouter({ config }));
    app.use("/api/queue", createQueueRouter({ config }));
    app.use("/api/radar", createRadarRouter({ config }));

    app.use((req, res) => {
        res.status(404).json({ error: "not_found" });
    });

    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        console.error("[error]", error.stack || error.message);

        if (res.headersSent) {
            return;
        }

        const status = error.status || 500;

        res.status(status).json({
            error: status === 500 ? "server_error" : error.code || "request_failed",
            message: status === 500 ? "Something went wrong on our side." : error.message
        });
    });

    return app;
}

/** Boots the service. Called by server.js and by `npm start`. */
async function start(env = process.env) {
    const config = loadConfig(env);

    if (!config.discord.redirectUri) {
        throw new Error(
            "DISCORD_REDIRECT_URI is not set. Add the callback URL you registered in the Discord developer portal."
        );
    }

    if (!config.discord.guildId || !config.discord.pilotRoleId || !config.discord.atcRoleId) {
        throw new Error(
            "DISCORD_GUILD_ID, PILOT_ROLE_ID and ATC_ROLE_ID are required. Role checks fail closed without them, " +
                "which would lock everyone out of ATC applications and radar."
        );
    }

    const store = new Store(config.databaseUrl);

    try {
        await store.migrate();
    } catch (error) {
        await store.close().catch(() => {});
        throw new Error(`Could not prepare the database: ${error.message}`);
    }

    const app = createApp({ config, store });
    const server = app.listen(config.port, () => {
        console.log(`[latc] listening on :${config.port} (${config.nodeEnv})`);
    });

    const shutdown = async (signal) => {
        console.log(`[latc] ${signal} received, shutting down`);
        server.close();
        await store.close().catch(() => {});
        process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    return { app, server, store, config };
}

module.exports = { createApp, start };
