"use strict";

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const BOT_DIR = path.resolve(__dirname, "..", "bot");
const BOT_ENTRY = path.join(BOT_DIR, "main.py");

/** Time the bot has to stay up before a crash is counted as a fresh start and
 *  the backoff ladder resets. */
const STABLE_MS = 60 * 1000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60 * 1000;

/**
 * Finds an interpreter that can run the bot.
 *
 * The project's own virtual environment comes first when it exists, because
 * that is where discord.py and asyncpg are installed. Falling through to a
 * bare `python3` from PATH would produce a confusing ImportError on a machine
 * that has Python but none of the bot's packages.
 *
 * Render's Node runtime ships Python as `python3`. On a laptop the same binary
 * is usually just `python`, and the Windows launcher is `py`. Probing with
 * `--version` rather than trusting a name on PATH is what makes one service
 * definition work in both places.
 *
 * Returns null when nothing is found, which is a normal outcome on a machine
 * with no Python at all: the API must still boot.
 */
function findPython(env = process.env, dir = BOT_DIR) {
    const venv = path.join(dir, ".venv");
    const candidates = [
        env.PYTHON_BIN,
        path.join(venv, "Scripts", "python.exe"),
        path.join(venv, "bin", "python"),
        "python3",
        "python",
        "py"
    ].filter(Boolean);

    for (const candidate of candidates) {
        const probe = spawnSync(candidate, ["--version"], {
            encoding: "utf8",
            windowsHide: true
        });

        if (probe.error || probe.status !== 0) {
            continue;
        }

        return candidate;
    }

    return null;
}

/**
 * Builds the environment handed to the bot process.
 *
 * The child inherits everything from the API process, so one set of variables
 * in the Render dashboard drives both halves. The two aliases below exist only
 * because the bot predates the API and names the same values differently:
 * it wants DISCORD_TOKEN/GUILD_ID, the API wants DISCORD_BOT_TOKEN/
 * DISCORD_GUILD_ID. Mapping here means nobody has to keep two names in sync
 * by hand.
 *
 * `process.env` wins over both, so an explicit override still applies.
 */
function botEnv(env = process.env) {
    const child = Object.assign({}, env);

    const token = env.DISCORD_TOKEN || env.DISCORD_BOT_TOKEN;
    const guild = env.GUILD_ID || env.DISCORD_GUILD_ID;

    if (token) {
        child.DISCORD_TOKEN = token;
    }

    if (guild) {
        child.GUILD_ID = guild;
    }

    /* The bot's own load_env_file() uses setdefault, so anything set here
       already beats its .env. Nothing else needs translating. */
    return child;
}

/**
 * Supervises the Python Discord bot as a child process.
 *
 * Design rules, in priority order:
 *
 * 1. The API never dies because of the bot. A missing interpreter, a missing
 *    dependency, or a bad token costs a logged line and a retry, never the
 *    HTTP service Render is health checking.
 * 2. The bot restarts on its own. Discord gateway drops, an unhandled
 *    exception, or a deploy that temporarily removes a variable all end in a
 *    restart with exponential backoff instead of a permanently dead bot.
 * 3. Giving up is explicit. Once the process has exited too many times inside
 *    a short window it stops retrying and says so, rather than burning a
 *    restart loop forever.
 */
class BotSupervisor {
    constructor(options = {}) {
        this.log = options.log || console.log.bind(console);
        this.env = options.env || process.env;
        this.enabled = options.enabled !== false;
        this.pythonBin = options.pythonBin || null;
        this.entry = options.entry || BOT_ENTRY;
        this.dir = options.dir || BOT_DIR;

        this.child = null;
        this.stopping = false;
        this.attempts = 0;
        this.spawnCount = 0;
        this.timer = null;
        this.startedAt = null;
        this.lastExit = null;
        this.state = "disabled";
        this.reason = null;
        this.output = "";
    }

    /** True when everything needed to run the bot is present on disk. */
    hasSource() {
        return fs.existsSync(this.entry);
    }

    start() {
        if (!this.enabled) {
            this.state = "disabled";
            this.reason = "bot disabled by configuration";
            this.log(`[bot] ${this.reason}`);
            return this;
        }

        if (!this.hasSource()) {
            this.state = "unavailable";
            this.reason = `bot source not found at ${this.entry}`;
            this.log(`[bot] ${this.reason} - skipping`);
            return this;
        }

        const python = this.pythonBin || findPython(this.env, this.dir);

        if (!python) {
            this.state = "unavailable";
            this.reason = "no Python interpreter found (set PYTHON_BIN)";
            this.log(`[bot] ${this.reason} - API continues without the bot`);
            return this;
        }

        this.pythonBin = python;
        this.stopping = false;
        this.spawnOnce();
        return this;
    }

    spawnOnce() {
        this.attempts += 1;
        this.spawnCount += 1;
        this.state = "starting";

        let child;

        try {
            child = spawn(this.pythonBin, [this.entry], {
                cwd: this.dir,
                env: botEnv(this.env),
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true
            });
        } catch (error) {
            this.state = "unavailable";
            this.reason = error.message;
            this.log(`[bot] failed to spawn: ${error.message}`);
            this.scheduleRestart();
            return;
        }

        this.child = child;
        this.startedAt = Date.now();
        this.state = "starting";

        this.log(`[bot] started pid ${child.pid} with ${this.pythonBin}`);

        const capture = (stream) => {
            stream.setEncoding("utf8");
            stream.on("data", (chunk) => {
                this.output = (this.output + chunk).slice(-8192);

                for (const line of chunk.split(/\r?\n/)) {
                    if (line.trim()) {
                        this.log(`[bot] ${line}`);
                    }
                }
            });
        };

        capture(child.stdout);
        capture(child.stderr);

        child.on("error", (error) => {
            this.state = "unavailable";
            this.reason = error.message;
            this.log(`[bot] process error: ${error.message}`);
            this.child = null;
            this.scheduleRestart();
        });

        child.on("exit", (code, signal) => {
            const ranFor = Date.now() - this.startedAt;
            this.lastExit = { code, signal, at: new Date().toISOString() };
            this.child = null;

            if (this.stopping) {
                this.state = "stopped";
                return;
            }

            this.log(
                `[bot] exited code=${code} signal=${signal} after ${Math.round(ranFor / 1000)}s`
            );

            if (ranFor >= STABLE_MS) {
                /* Ran long enough to be considered healthy: the failure was
                   transient, so start the ladder over instead of treating it
                   as part of the same crash run. */
                this.attempts = 0;
            }

            this.state = "restarting";
            this.scheduleRestart();
        });

        /* Once the gateway is up the child is doing its job. Discord can still
           drop it later, but this is the earliest point we can call it live. */
        child.stdout.once("data", () => {
            if (this.state === "starting") {
                this.state = "running";
                this.log("[bot] producing output - running");
            }
        });
    }

    scheduleRestart() {
        if (this.stopping || this.timer) {
            return;
        }

        if (this.attempts >= 8) {
            this.state = "gave-up";
            this.reason = "bot exceeded restart limit; not retrying";
            this.log(`[bot] ${this.reason}. Fix the error above and restart the service.`);
            return;
        }

        const delay = Math.min(
            BACKOFF_START_MS * 2 ** Math.max(0, this.attempts - 1),
            BACKOFF_MAX_MS
        );

        this.log(`[bot] restarting in ${delay}ms (attempt ${this.attempts + 1})`);

        this.timer = setTimeout(() => {
            this.timer = null;

            if (this.stopping) {
                return;
            }

            this.spawnOnce();
        }, delay);

        if (typeof this.timer.unref === "function") {
            this.timer.unref();
        }
    }

    /** Status blob for /health. Never throws. */
    status() {
        return {
            enabled: this.enabled,
            state: this.state,
            pid: this.child ? this.child.pid : null,
            python: this.pythonBin,
            spawnCount: this.spawnCount,
            startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
            lastExit: this.lastExit,
            reason: this.reason
        };
    }

    /** True while the bot is believed to be alive. Health stays green either
     *  way - see start() rule 1. */
    isRunning() {
        return Boolean(this.child) && this.state === "running";
    }

    stop(timeoutMs = 5000) {
        this.stopping = true;
        this.state = "stopped";

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        const child = this.child;

        if (!child) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            let settled = false;

            const done = () => {
                if (settled) {
                    return;
                }
                settled = true;
                this.log("[bot] stopped");
                resolve();
            };

            child.once("exit", done);

            try {
                child.kill("SIGTERM");
            } catch (error) {
                this.log(`[bot] kill failed: ${error.message}`);
                done();
                return;
            }

            const force = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    this.log("[bot] did not exit in time - killing");
                    try {
                        child.kill("SIGKILL");
                    } catch (error) {
                        this.log(`[bot] SIGKILL failed: ${error.message}`);
                    }
                }
                done();
            }, timeoutMs);

            if (typeof force.unref === "function") {
                force.unref();
            }
        });
    }
}

module.exports = { BotSupervisor, botEnv, findPython, BOT_DIR };
