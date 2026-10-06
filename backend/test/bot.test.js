"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BotSupervisor, botEnv } = require("../src/bot");
const { createApp } = require("../src/server");
const { FakeStore, rows } = require("./helpers");

/**
 * The supervisor is the only thing between a crashing Discord bot and a
 * restarted API. These tests cover the two properties that matter: it keeps
 * the bot running on its own, and it never lets the bot take the API with it.
 *
 * Spawn tests use Node as the interpreter so the suite still runs on a machine
 * with no Python installed. The child is invoked as `<bin> <entry>`, which is
 * exactly how python3 runs main.py.
 */

const quiet = () => {};

function script(body) {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "latc-bot-")),
        "child.js"
    );
    fs.writeFileSync(file, body, "utf8");
    return file;
}

const NEVER = "process.exitCode = 0; setTimeout(() => {}, 60000);";

test("botEnv translates the API's names into the names the bot expects", () => {
    const out = botEnv({
        DISCORD_BOT_TOKEN: "token-from-api",
        DISCORD_GUILD_ID: "123456789012345678",
        DATABASE_URL: "postgres://example"
    });

    assert.equal(out.DISCORD_TOKEN, "token-from-api");
    assert.equal(out.GUILD_ID, "123456789012345678");
    assert.equal(out.DATABASE_URL, "postgres://example");
});

test("botEnv prefers a value already named the way the bot wants it", () => {
    const out = botEnv({
        DISCORD_TOKEN: "direct",
        DISCORD_BOT_TOKEN: "alias",
        GUILD_ID: "111111111111111111",
        DISCORD_GUILD_ID: "222222222222222222"
    });

    assert.equal(out.DISCORD_TOKEN, "direct");
    assert.equal(out.GUILD_ID, "111111111111111111");
});

test("a disabled supervisor reports itself and spawns nothing", async () => {
    const bot = new BotSupervisor({ enabled: false, log: quiet, pythonBin: process.execPath });
    bot.start();

    assert.equal(bot.state, "disabled");
    assert.equal(bot.child, null);
    assert.equal(bot.isRunning(), false);
    await bot.stop();
});

test("a missing interpreter leaves the supervisor unavailable, not throwing", async () => {
    const bot = new BotSupervisor({
        enabled: true,
        log: quiet,
        pythonBin: "definitely-not-a-real-interpreter-xyz"
    });

    bot.start();

    /* spawn() reports a bad command through an error event rather than by
       throwing, so the outcome has to be waited for. */
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(bot.state, "unavailable");
    assert.ok(bot.status().reason);
    await bot.stop();
});

test("missing bot source is reported without attempting a spawn", async () => {
    const bot = new BotSupervisor({
        enabled: true,
        log: quiet,
        pythonBin: process.execPath,
        entry: path.join(os.tmpdir(), "latc-does-not-exist.py")
    });

    bot.start();

    assert.equal(bot.state, "unavailable");
    await bot.stop();
});

test("a child that stays up is reported as running", async () => {
    const bot = new BotSupervisor({
        enabled: true,
        log: quiet,
        pythonBin: process.execPath,
        entry: script("console.log('gateway ready'); " + NEVER)
    });

    bot.start();
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(bot.state, "running");
    assert.equal(bot.isRunning(), true);
    assert.ok(bot.status().pid);

    await bot.stop();
    assert.equal(bot.state, "stopped");
    assert.equal(bot.child, null);
});

test("a child that only writes to stderr is reported as running", async () => {
    const bot = new BotSupervisor({
        enabled: true,
        log: quiet,
        pythonBin: process.execPath,
        entry: script("console.error('gateway ready'); " + NEVER)
    });

    bot.start();
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(bot.state, "running");
    assert.equal(bot.isRunning(), true);

    await bot.stop();
    assert.equal(bot.state, "stopped");
});

test("a crashing child is restarted rather than left dead", async () => {
    const bot = new BotSupervisor({
        enabled: true,
        log: quiet,
        pythonBin: process.execPath,
        entry: script("process.exit(1);")
    });

    bot.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(bot.lastExit, "an exit was recorded");
    assert.equal(bot.lastExit.code, 1);
    assert.ok(["restarting", "starting"].includes(bot.state), `state was ${bot.state}`);
    assert.ok(bot.timer, "a restart is scheduled");

    await bot.stop();
    assert.equal(bot.timer, null);
});

test("repeated failures stop the ladder instead of looping forever", async () => {
    const bot = new BotSupervisor({
        enabled: true,
        log: quiet,
        pythonBin: process.execPath,
        entry: script("process.exit(2);")
    });

    /* Drive the counter directly: scheduleRestart() will not arm a second
       timer while one is pending, which is the behaviour being bypassed here. */
    for (let i = 0; i < 9; i += 1) {
        bot.attempts += 1;
        bot.scheduleRestart();
        clearTimeout(bot.timer);
        bot.timer = null;
    }

    assert.equal(bot.state, "gave-up");
    assert.equal(bot.timer, null);
    assert.match(bot.status().reason, /restart limit/);
    await bot.stop();
});

test("stop() is safe when nothing was ever started", async () => {
    const bot = new BotSupervisor({ enabled: false, log: quiet });
    await bot.stop();
    assert.equal(bot.state, "stopped");
});

/**
 * /health is what Render watches. A dead bot must stay visible there without
 * flipping the response to 503, because a bot outage should not also be an
 * API outage.
 */
test("/health reports bot state without failing the check", async () => {
    const config = loadTestConfig();
    const store = new FakeStore({ "SELECT 1": rows([{ "?column?": 1 }]) });

    const down = createApp({
        config,
        store,
        bot: { status: () => ({ state: "gave-up" }) }
    });

    const server = down.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));

    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.bot.state, "gave-up");

    await new Promise((resolve) => server.close(resolve));
});

test("/health still answers when no bot was constructed at all", async () => {
    const config = loadTestConfig();
    const store = new FakeStore({ "SELECT 1": rows([{ "?column?": 1 }]) });

    const app = createApp({ config, store });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));

    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.bot.state, "not_started");

    await new Promise((resolve) => server.close(resolve));
});

test("/health reports the database as unreachable", async () => {
    const config = loadTestConfig();
    const store = new FakeStore({
        "SELECT 1": () => {
            throw new Error("connection refused");
        }
    });

    const app = createApp({ config, store });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));

    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await res.json();

    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.error, "database_unreachable");

    await new Promise((resolve) => server.close(resolve));
});

test("config exposes the bot block with both token spellings accepted", () => {
    const { loadConfig } = require("../src/config");
    const base = {
        DATABASE_URL: "postgres://user:pass@localhost:5432/test",
        SESSION_SECRET: "test-secret-value",
        DISCORD_CLIENT_ID: "client",
        DISCORD_CLIENT_SECRET: "secret",
        DISCORD_GUILD_ID: "999999999999999999",
        PILOT_ROLE_ID: "111111111111111111",
        ATC_ROLE_ID: "222222222222222222",
        PRIVATE_INVITE_URL: "https://discord.gg/private-invite"
    };

    assert.equal(loadConfig({ ...base, DISCORD_BOT_TOKEN: "a" }).bot.token, "a");
    assert.equal(loadConfig({ ...base, DISCORD_TOKEN: "b" }).bot.token, "b");
    assert.equal(
        loadConfig({ ...base, DISCORD_TOKEN: "b", DISCORD_BOT_TOKEN: "a" }).bot.token,
        "b",
        "the exact name the bot wants wins"
    );
    assert.equal(loadConfig({ ...base, BOT_ENABLED: "false" }).bot.enabled, false);
    assert.equal(loadConfig({ ...base }).bot.enabled, true);
});

function loadTestConfig() {
    const { loadConfig } = require("../src/config");

    return loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://user:pass@localhost:5432/test",
        SESSION_SECRET: "test-secret-value",
        DISCORD_CLIENT_ID: "client",
        DISCORD_CLIENT_SECRET: "secret",
        DISCORD_GUILD_ID: "999999999999999999",
        PILOT_ROLE_ID: "111111111111111111",
        ATC_ROLE_ID: "222222222222222222",
        PRIVATE_INVITE_URL: "https://discord.gg/private-invite",
        SESSION_SECURE: "false",
        ALLOWED_ORIGINS: "http://localhost:8000"
    });
}
