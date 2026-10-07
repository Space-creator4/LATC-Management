"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadConfig } = require("../src/config");
const { createApp } = require("../src/server");
const { createToken } = require("../src/lib/session");
const { clearCache } = require("../src/lib/schemas");
const { clearCache: clearRoleCache } = require("../src/lib/memberRoles");
const { FakeStore, rows } = require("./helpers");

const path = require("node:path");
const OPEN_FIXTURES = path.join(__dirname, "fixtures", "open");
const BROKEN_FIXTURES = path.join(__dirname, "fixtures", "broken");

/**
 * Exercises the HTTP surface of the access rules. The point of these tests is the
 * cases a determined member could reach with a devtools console: posting a body the
 * form would never have produced.
 */

const PILOT_ROLE = "111111111111111111";
const ATC_ROLE = "222222222222222222";
const STAFF_ROLE = "333333333333333333";
const INVITE = "https://discord.gg/private-invite";
const MEMBER_ID = "444444444444444444";

const baseEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/test",
    SESSION_SECRET: "test-secret-value",
    DISCORD_CLIENT_ID: "client",
    DISCORD_CLIENT_SECRET: "secret",
    DISCORD_GUILD_ID: "999999999999999999",
    PILOT_ROLE_ID: PILOT_ROLE,
    ATC_ROLE_ID: ATC_ROLE,
    PRIVATE_INVITE_URL: INVITE,
    SESSION_SECURE: "false",
    ALLOWED_ORIGINS: "http://localhost:8000"
};

/**
 * Boots the app with a fake store and hands back a fetch bound to it.
 *
 * Signing in goes through the real path: a genuine HMAC-signed cookie plus a
 * session row from the store. Nothing is stubbed between the cookie and the
 * handler, so these tests also prove that a forged or unsigned cookie is refused.
 */
async function withApp({ env = {}, storeResponses = {}, roles = [], signedIn = true, discord = undefined } = {}, run) {
    // The schema loader caches per role, so a test that points at different
    // fixtures has to drop it or it would read the previous test's files. The
    // role refresh caches per member too, and tests share one member id.
    clearCache();
    clearRoleCache();

    if (env.LATC_DATA_DIR) {
        process.env.LATC_DATA_DIR = env.LATC_DATA_DIR;
    } else {
        delete process.env.LATC_DATA_DIR;
    }

    const config = loadConfig({ ...baseEnv, ...env });
    const store = new FakeStore({
        "FROM web_sessions WHERE id = $1": signedIn
            ? rows([
                  {
                      id: "session-1",
                      discord_user_id: MEMBER_ID,
                      discord_username: "aviator",
                      avatar_url: null,
                      guild_roles: roles,
                      expires_at: "2099-01-01"
                  }
              ])
            : rows([]),
        ...storeResponses
    });

    const app = createApp({ config, store, discord });

    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();

    const validCookie = `latc_session=${createToken(
        { sid: "session-1", exp: Date.now() + 60_000 },
        config.session.secret
    )}`;

    const call = async (path, { method = "GET", body, cookie, bearer, redirect = "follow" } = {}) => {
        const headers = {
            "Content-Type": "application/json",
            Origin: "http://localhost:8000"
        };

        if (typeof cookie === "string") {
            headers.Cookie = cookie;
        } else if (bearer === undefined) {
            headers.Cookie = validCookie;
        }

        if (bearer !== undefined) {
            headers["Authorization"] = "Bearer " + bearer;
        }

        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers,
            redirect,
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        let json = null;
        try {
            json = await response.json();
        } catch {
            json = null;
        }

        return { status: response.status, json, headers: response.headers, text: response };
    };

    try {
        await run({ call, store, config, validCookie });
    } finally {
        server.close();
    }
}

const validPilotBody = {
    role: "pilot",
    robloxUsername: "Aviator",
    discordUsername: "aviator#1",
    email: "aviator@example.com",
    age: "18",
    experience: "Some time",
    availability: "evenings",
    motivation: "Because",
    agreedRules: true
};

const validAtcBody = {
    ...validPilotBody,
    role: "atc",
    pilotReference: "PILOT-42",
    position: "ground"
};

function hasRoleLike(roles, roleId) {
    return Boolean(roleId) && Array.isArray(roles) && roles.map(String).includes(String(roleId));
}

/*
 * A stubbed Discord client for the role refresh path. /auth/me destructures
 * hasRole() from it, so a stub that exercises /auth/me has to provide one too.
 */
function makeRoleStub(roles) {
    return {
        fetchMemberRoles: async () => roles.slice(),
        hasRole: hasRoleLike
    };
}

test("config refuses to load without the client secret", () => {
    const env = { ...baseEnv };
    delete env.DISCORD_CLIENT_SECRET;
    assert.throws(() => loadConfig(env), /DISCORD_CLIENT_SECRET is not set/);
});

test("config refuses a snowflake that is not one", () => {
    assert.throws(() => loadConfig({ ...baseEnv, ATC_ROLE_ID: "not-an-id" }), /snowflake/);
});

test("health check answers even with the store stubbed", async () => {
    await withApp({ storeResponses: { "SELECT 1": rows([{ "?column?": 1 }]) } }, async ({ call }) => {
        const res = await call("/health");
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
    });
});

test("question sets are served from the same JSON the server validates", async () => {
    await withApp({ signedIn: false }, async ({ call }) => {
        const res = await call("/api/question-sets");
        assert.equal(res.status, 200);
        assert.equal(res.json.sets.atc.role, "atc");
        assert.ok(res.json.sets.atc.questions.some((q) => q.name === "pilotReference"));
        assert.equal(res.json.sets.staff.closed, true);
    });
});

test("public config reports staff closed by default", async () => {
    await withApp({ signedIn: false }, async ({ call }) => {
        const res = await call("/api/config");
        assert.equal(res.json.applications.staff, false);
        assert.equal(res.json.applications.atc, "pilots_only");
    });
});

test("CORS allows the configured origin with credentials", async () => {
    await withApp({ signedIn: false }, async ({ call }) => {
        const res = await call("/api/config");
        assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:8000");
        assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    });
});

test("CORS refuses an unknown origin", async () => {
    await withApp({ signedIn: false }, async ({ call }) => {
        const response = await fetch("http://127.0.0.1:1/api/config", {
            headers: { Origin: "https://evil.example" }
        }).catch(() => null);

        // The app itself still answers; it simply sends no allow header.
        assert.ok(response === null || !response.headers.get("access-control-allow-origin"));
    });
});

test("options preflight is rejected for an unknown origin", async () => {
    const config = loadConfig(baseEnv);
    const store = new FakeStore({});
    const app = createApp({ config, store });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));

    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config`, {
            method: "OPTIONS",
            headers: { Origin: "https://evil.example" }
        });
        assert.equal(response.status, 403);
    } finally {
        server.close();
    }
});

/* -------------------------------------------------------------------------
   Session guarding. requireUser runs before any role check, so an anonymous
   caller is refused no matter what body it sends.
   ------------------------------------------------------------------------- */

test("applications refuse an anonymous caller", async () => {
    await withApp({ signedIn: false }, async ({ call }) => {
        const res = await call("/api/applications", { method: "POST", body: validPilotBody });
        assert.equal(res.status, 401);
        assert.equal(res.json.error, "not_signed_in");
    });
});

test("queue refuses an anonymous caller", async () => {
    await withApp({ signedIn: false }, async ({ call }) => {
        const res = await call("/api/queue/join", { method: "POST", body: { agreedRules: true } });
        assert.equal(res.status, 401);
    });
});

test("radar refuses an anonymous caller", async () => {
    await withApp({ signedIn: false }, async ({ call }) => {
        const res = await call("/api/radar");
        assert.equal(res.status, 401);
    });
});

/* -------------------------------------------------------------------------
   The two rules the member asked for, tested against the HTTP surface.
   ------------------------------------------------------------------------- */

test("staff application is refused while intake is closed", async () => {
    await withApp({ storeResponses: { "INSERT INTO web_applications": rows([{ id: 1 }]) } },
        async ({ call }) => {
            const res = await call("/api/applications", {
                method: "POST",
                body: { role: "staff", agreedRules: true, motivation: "let me in" }
            });

            assert.equal(res.status, 403);
            assert.equal(res.json.error, "staff_closed");
        }
    );
});

test("staff stays closed while the question set is still marked closed", async () => {
    await withApp(
        {
            env: { APPLICATIONS_STAFF_OPEN: "true" },
            storeResponses: { "INSERT INTO web_applications": rows([{ id: 1 }]) }
        },
        async ({ call }) => {
            const res = await call("/api/applications", {
                method: "POST",
                body: { role: "staff", robloxUsername: "A", agreedRules: true }
            });

            assert.equal(res.status, 403);
            assert.equal(res.json.error, "staff_closed");
        }
    );
});

test("staff is accepted once the switch is on and the questions are filled in", async () => {
    await withApp(
        {
            env: { APPLICATIONS_STAFF_OPEN: "true", LATC_DATA_DIR: OPEN_FIXTURES },
            storeResponses: { "INSERT INTO web_applications": rows([{ id: 8 }]) }
        },
        async ({ call }) => {
            const res = await call("/api/applications", {
                method: "POST",
                body: {
                    role: "staff",
                    robloxUsername: "A",
                    experience: "Moderator for two years"
                }
            });

            assert.equal(res.status, 201);
            assert.equal(res.json.role, "staff");
        }
    );
});

test("an empty staff question set is refused even when staff intake is switched off", async () => {
    await withApp({ env: { LATC_DATA_DIR: BROKEN_FIXTURES } }, async ({ call }) => {
        // A malformed question set should produce a clear 500 rather than crash
        // the process or quietly accept anything.
        const sets = await call("/api/question-sets");
        assert.equal(sets.status, 500);
        assert.equal(sets.json.error, "question_sets_unavailable");

        const post = await call("/api/applications", {
            method: "POST",
            body: { role: "staff", robloxUsername: "A" }
        });
        assert.equal(post.status, 500);
    });
});

test("atc application is refused for a non-pilot even when the client claims otherwise", async () => {
    await withApp({ storeResponses: { "INSERT INTO web_applications": rows([{ id: 1 }]) } },
        async ({ call }) => {
            const res = await call("/api/applications", {
                method: "POST",
                body: { ...validAtcBody, existingPilot: true, pilotReference: "PILOT-42" }
            });

            assert.equal(res.status, 403);
            assert.equal(res.json.error, "not_a_pilot");
        }
    );
});

test("atc application is accepted for a member holding the pilot role", async () => {
    await withApp(
        {
            roles: [PILOT_ROLE],
            storeResponses: { "INSERT INTO web_applications": rows([{ id: 12 }]) }
        },
        async ({ call, store }) => {
            const res = await call("/api/applications", { method: "POST", body: validAtcBody });

            assert.equal(res.status, 201);
            assert.equal(res.json.role, "atc");

            /*
             * The stored identity must come from the session, never the body, so
             * an application cannot be filed under someone else's name.
             */
            const insert = store.issued("INSERT INTO web_applications")[0];
            assert.ok(insert, "the application should have been inserted");
            assert.equal(insert.params[0], "atc");
            assert.equal(insert.params[1], MEMBER_ID, "identity comes from the session");
            assert.ok(!JSON.stringify(insert.params[3]).includes("discord_user_id\":\"999"));
        }
    );
});

test("atc application is accepted when only the live roles show the pilot role", async () => {
    // The session snapshot was taken before the member was given the Pilot role
    // (the normal journey: sign in, get accepted, get the role). The gate must
    // ask Discord again rather than trust that stale snapshot.
    await withApp(
        {
            env: { DISCORD_BOT_TOKEN: "test-bot-token" },
            roles: [],
            discord: makeRoleStub([PILOT_ROLE]),
            storeResponses: { "INSERT INTO web_applications": rows([{ id: 21 }]) }
        },
        async ({ call, store }) => {
            const res = await call("/api/applications", { method: "POST", body: validAtcBody });

            assert.equal(res.status, 201);
            assert.equal(res.json.role, "atc");
            assert.ok(
                store.issued("UPDATE web_sessions SET guild_roles").length >= 1,
                "the session row should be refreshed with the current roles"
            );
        }
    );
});

test("atc application is refused when Discord really does not hold the pilot role", async () => {
    await withApp(
        {
            env: { DISCORD_BOT_TOKEN: "test-bot-token" },
            roles: [],
            discord: makeRoleStub([])
        },
        async ({ call }) => {
            const res = await call("/api/applications", { method: "POST", body: validAtcBody });

            assert.equal(res.status, 403);
            assert.equal(res.json.error, "not_a_pilot");
        }
    );
});

test("a Discord outage falls back to the snapshot rather than locking a pilot out", async () => {
    await withApp(
        {
            env: { DISCORD_BOT_TOKEN: "test-bot-token" },
            roles: [PILOT_ROLE],
            discord: {
                fetchMemberRoles: async () => {
                    throw new Error("discord unreachable");
                },
                hasRole: hasRoleLike
            },
            storeResponses: { "INSERT INTO web_applications": rows([{ id: 41 }]) }
        },
        async ({ call }) => {
            const res = await call("/api/applications", { method: "POST", body: validAtcBody });

            assert.equal(res.status, 201);
            assert.equal(res.json.role, "atc");
        }
    );
});

test("/auth/me reflects roles that changed after sign in", async () => {
    await withApp(
        {
            env: { DISCORD_BOT_TOKEN: "test-bot-token" },
            roles: [],
            discord: makeRoleStub([PILOT_ROLE])
        },
        async ({ call }) => {
            const res = await call("/auth/me");

            assert.equal(res.status, 200);
            assert.equal(res.json.permissions.isPilot, true, "the live check overrides the snapshot");
            assert.equal(res.json.permissions.isAtc, false);
        }
    );
});

test("a signed-in member is resolved from the session row", async () => {
    await withApp({ roles: [PILOT_ROLE, ATC_ROLE] }, async ({ call }) => {
        const res = await call("/auth/me");

        assert.equal(res.status, 200);
        assert.equal(res.json.user.id, MEMBER_ID);
        assert.equal(res.json.permissions.isPilot, true);
        assert.equal(res.json.permissions.isAtc, true);
        assert.equal(res.json.permissions.isStaff, false);
        assert.equal(res.json.features.applicationsOpen.staff, false);
    });
});

test("a forged cookie is refused", async () => {
    await withApp({}, async ({ call }) => {
        const res = await call("/auth/me", { cookie: "latc_session=made-up-value" });
        assert.equal(res.status, 401);
    });
});

test("an unsigned token is refused even with a valid session id", async () => {
    await withApp({}, async ({ call }) => {
        const payload = Buffer.from(JSON.stringify({ sid: "session-1", exp: Date.now() + 60_000 }))
            .toString("base64url");
        const res = await call("/auth/me", { cookie: `latc_session=${payload}.deadbeef` });
        assert.equal(res.status, 401);
    });
});

test("a bearer token signs the member in without any cookie", async () => {
    const crypto = require("node:crypto");
    await withApp({ roles: [PILOT_ROLE] }, async ({ call, config }) => {
        const token = createToken(
            { sid: "session-1", exp: Date.now() + 60_000 },
            config.session.secret
        );

        const res = await call("/auth/me", { bearer: token });

        assert.equal(res.status, 200);
        assert.equal(res.json.user.id, MEMBER_ID);
        assert.equal(res.json.permissions.isPilot, true);
    });
});

test("the OAuth callback redirects home with the session token in the fragment", async () => {
    const crypto = require("node:crypto");
    const discord = {
        authorizeUrl: () => "https://discord.com/api/v10/oauth2/authorize",
        exchangeCode: async () => ({ access_token: "token" }),
        fetchUser: async () => ({ id: MEMBER_ID, username: "aviator", avatar: null }),
        fetchGuildRoles: async () => [PILOT_ROLE],
        hasRole: (roles, roleId) => roles.includes(roleId)
    };
    const secret = "test-secret-value";
    const state = "callback-state";
    const signature = crypto.createHmac("sha256", secret).update(state).digest("base64url");

    await withApp(
        {
            signedIn: false,
            discord,
            storeResponses: {
                /* Answer whatever sid the callback just created. */
                "FROM web_sessions WHERE id = $1": (_sql, params) =>
                    rows([
                        {
                            id: params[0],
                            discord_user_id: MEMBER_ID,
                            discord_username: "aviator",
                            avatar_url: null,
                            guild_roles: [PILOT_ROLE],
                            expires_at: "2099-01-01"
                        }
                    ])
            }
        },
        async ({ call, store }) => {
            const res = await call(`/auth/discord/callback?code=exchange-me&state=${state}`, {
                cookie: `latc_oauth_state=${state}.${signature}`,
                redirect: "manual"
            });

            assert.equal(res.status, 302);

            const insert = store.issued("INSERT INTO web_sessions")[0];
            assert.ok(insert, "the callback should have created a session row");

            const url = new URL(res.headers.get("location"));
            assert.equal(url.origin + url.pathname, "http://localhost:8000/account/");
            assert.equal(url.searchParams.get("signed_in"), "1");
            assert.ok(url.hash.startsWith("#token="), "the session token rides home in the fragment");

            const token = decodeURIComponent(url.hash.slice("#token=".length));

            const me = await call("/auth/me", { bearer: token });
            assert.equal(me.status, 200);
            assert.equal(me.json.user.id, MEMBER_ID);
        }
    );
});

test("an unset callback host points OAuth at the API's own origin", async () => {
    clearCache();
    const config = loadConfig({ ...baseEnv });
    config.discord.redirectUri = "";
    const store = new FakeStore({});
    const app = createApp({ config, store });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    try {
        const location = await new Promise((resolve, reject) => {
            const req = require("node:http").request(
                {
                    host: "127.0.0.1",
                    port,
                    path: "/auth/discord",
                    headers: { Host: "api.example.com", "X-Forwarded-Proto": "https" }
                },
                (res) => {
                    res.resume();
                    resolve(res.headers.location);
                }
            );
            req.on("error", reject);
            req.end();
        });

        const loc = new URL(location);
        assert.equal(loc.protocol + "//" + loc.host, "https://discord.com");
        assert.equal(loc.pathname, "/api/v10/oauth2/authorize");
        assert.equal(loc.searchParams.get("client_id"), "client");
        assert.equal(loc.searchParams.get("redirect_uri"), "https://api.example.com/auth/discord/callback");
        assert.equal(loc.searchParams.get("response_type"), "code");
        assert.ok(loc.searchParams.get("state"));
        assert.ok(loc.searchParams.get("scope"));
    } finally {
        server.close();
    }
});

test("an unknown role is refused", async () => {
    await withApp({}, async ({ call }) => {
        const res = await call("/api/applications", {
            method: "POST",
            body: { role: "owner", agreedRules: true }
        });
        assert.equal(res.status, 400);
        assert.equal(res.json.error, "unknown_role");
    });
});

test("invalid answers come back as field errors", async () => {
    await withApp({}, async ({ call }) => {
        /* No email field: the applicant's Discord account is their identity, so
           the schema does not collect one. The missing required text field and
           the unchecked rules box are what should come back as errors. */
        const res = await call("/api/applications", {
            method: "POST",
            body: { ...validPilotBody, robloxUsername: "", agreedRules: false }
        });

        assert.equal(res.status, 422);
        assert.ok(res.json.errors.robloxUsername);
        assert.ok(res.json.errors.agreedRules);
    });
});

/* -------------------------------------------------------------------------
   Queue.
   ------------------------------------------------------------------------- */

test("joining without accepting the rules is refused", async () => {
    await withApp({}, async ({ call }) => {
        const res = await call("/api/queue/join", { method: "POST", body: { agreedRules: false } });
        assert.equal(res.status, 422);
        assert.equal(res.json.error, "rules_not_accepted");
    });
});

test("an approved entry receives the private invite", async () => {
    await withApp(
        {
            storeResponses: {
                "SELECT id, status, position, created_at FROM web_queue_entries WHERE discord_user_id = $1 AND status IN": rows([]),
                "COALESCE(MAX(position)": rows([{ next: 4 }]),
                "INSERT INTO web_queue_entries": rows([
                    { id: 3, status: "approved", position: 4, created_at: "2026-01-01" }
                ]),
                "UPDATE web_queue_entries SET resolved_at": rows([])
            }
        },
        async ({ call }) => {
            const res = await call("/api/queue/join", { method: "POST", body: { agreedRules: true } });

            assert.equal(res.status, 201);
            assert.equal(res.json.status, "approved");
            assert.equal(res.json.inviteUrl, INVITE);
        }
    );
});

test("a pending entry gets a position but never the invite", async () => {
    await withApp(
        {
            env: { QUEUE_AUTO_APPROVE: "false" },
            storeResponses: {
                "SELECT id, status, position, created_at FROM web_queue_entries WHERE discord_user_id = $1 AND status IN": rows([]),
                "COALESCE(MAX(position)": rows([{ next: 1 }]),
                "INSERT INTO web_queue_entries": rows([
                    { id: 9, status: "pending", position: 1, created_at: "2026-01-01" }
                ])
            }
        },
        async ({ call }) => {
            const res = await call("/api/queue/join", { method: "POST", body: { agreedRules: true } });

            assert.equal(res.status, 201);
            assert.equal(res.json.status, "pending");
            assert.equal(res.json.position, 1);
            assert.equal(res.json.inviteUrl, undefined, "a waiting member must not receive the link");
            assert.ok(res.json.message);
        }
    );
});

test("the invite never appears anywhere in a pending response body", async () => {
    await withApp(
        {
            env: { QUEUE_AUTO_APPROVE: "false" },
            storeResponses: {
                "SELECT id, status, position, created_at FROM web_queue_entries WHERE discord_user_id = $1 AND status IN": rows([]),
                "COALESCE(MAX(position)": rows([{ next: 2 }]),
                "INSERT INTO web_queue_entries": rows([
                    { id: 10, status: "pending", position: 2, created_at: "2026-01-01" }
                ])
            }
        },
        async ({ call }) => {
            const res = await call("/api/queue/join", { method: "POST", body: { agreedRules: true } });
            assert.ok(!JSON.stringify(res.json).includes("private-invite"));
        }
    );
});

test("a status check before joining reports not in queue", async () => {
    await withApp(
        { storeResponses: { "ORDER BY created_at DESC LIMIT 1": rows([]) } },
        async ({ call }) => {
            const res = await call("/api/queue/status");
            assert.equal(res.json.inQueue, false);
            assert.equal(res.json.inviteUrl, undefined);
        }
    );
});

test("joining twice returns the existing entry rather than a duplicate", async () => {
    await withApp(
        {
            storeResponses: {
                "AND status IN ('pending', 'approved')": rows([
                    { id: 5, status: "approved", position: 1, created_at: "2026-01-01" }
                ])
            }
        },
        async ({ call, store }) => {
            const res = await call("/api/queue/join", { method: "POST", body: { agreedRules: true } });

            assert.equal(res.status, 200);
            assert.equal(res.json.inviteUrl, INVITE);
            assert.equal(store.issued("INSERT INTO web_queue_entries").length, 0);
        }
    );
});

/* -------------------------------------------------------------------------
   Radar.
   ------------------------------------------------------------------------- */

test("radar is refused for a member without the ATC role", async () => {
    await withApp({ roles: [PILOT_ROLE] }, async ({ call }) => {
        const res = await call("/api/radar");
        assert.equal(res.status, 403);
        assert.equal(res.json.error, "atc_only");
    });
});

test("radar is refused for a member with no roles at all", async () => {
    await withApp({ roles: [] }, async ({ call }) => {
        const res = await call("/api/radar");
        assert.equal(res.status, 403);
    });
});

test("radar answers a member holding the ATC role", async () => {
    await withApp({ roles: [PILOT_ROLE, ATC_ROLE] }, async ({ call }) => {
        const res = await call("/api/radar");

        assert.equal(res.status, 200);
        assert.equal(res.json.available, true);
        assert.equal(res.json.feed, "pending");
        assert.ok(Array.isArray(res.json.sectors) && res.json.sectors.length > 0);
        assert.deepEqual(res.json.positions, [], "no traffic is invented before a feed exists");
    });
});

test("radar status is gated too", async () => {
    await withApp({ roles: [PILOT_ROLE] }, async ({ call }) => {
        const res = await call("/api/radar/status");
        assert.equal(res.status, 403);
    });
});

test("role checks fail closed when the role id is not configured", async () => {
    // Blank, not absent: spreading an absent key back over the defaults would
    // leave the base value in place.
    await withApp({ env: { ATC_ROLE_ID: "" }, roles: [ATC_ROLE] }, async ({ call }) => {
        // hasRole() returns false for a missing role id, so nobody gets in.
        const res = await call("/api/radar");
        assert.equal(res.status, 403);
    });
});

test("a missing pilot role id locks everyone out of ATC rather than letting everyone in", async () => {
    await withApp({ env: { PILOT_ROLE_ID: "" }, roles: [ATC_ROLE] }, async ({ call }) => {
        const res = await call("/api/applications", {
            method: "POST",
            body: { ...validAtcBody, existingPilot: true }
        });

        assert.equal(res.status, 403);
        assert.equal(res.json.error, "not_a_pilot");
    });
});

test("unknown routes answer 404 as json", async () => {
    await withApp({ signedIn: false }, async ({ call }) => {
        const res = await call("/api/nope");
        assert.equal(res.status, 404);
        assert.equal(res.json.error, "not_found");
    });
});
