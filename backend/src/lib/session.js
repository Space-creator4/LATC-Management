"use strict";

const crypto = require("node:crypto");

/**
 * Signed session cookies.
 *
 * The cookie holds an opaque session id, not user data, so revoking a session is
 * a DELETE and nothing about the member is readable in the browser. The id is
 * signed with HMAC-SHA256 to stop anyone inventing one, and the session row in
 * Postgres is what actually grants access.
 */

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function sign(value, secret) {
    return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function createToken(payload, secret) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${sign(body, secret)}`;
}

/**
 * Returns the payload when the signature matches and nothing has expired,
 * otherwise null. Comparison is constant time.
 */
function readToken(token, secret) {
    if (typeof token !== "string" || !token.includes(".")) {
        return null;
    }

    const [body, signature] = token.split(".");

    if (!body || !signature) {
        return null;
    }

    const expected = sign(body, secret);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return null;
    }

    let payload;

    try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return null;
    }

    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) {
        return null;
    }

    return payload;
}

/**
 * Express middleware factory. Attaches req.session and req.user for a valid
 * session, and is a no-op otherwise so routes decide their own response.
 */
function sessionMiddleware({ store, config }) {
    const { cookieName, secret, maxAgeDays, secure } = config.session;
    const ttlMs = maxAgeDays * SESSION_TTL_MS;

    return async function attachSession(req, res, next) {
        req.session = null;
        req.user = null;

        const token = req.cookies ? req.cookies[cookieName] : null;
        const payload = readToken(token, secret);

        if (payload && payload.sid) {
            try {
                const result = await store.query(
                    "SELECT id, discord_user_id, discord_username, avatar_url, guild_roles, expires_at " +
                        "FROM web_sessions WHERE id = $1 AND expires_at > now()",
                    [payload.sid]
                );

                if (result.rows.length) {
                    const row = result.rows[0];
                    req.session = { id: row.id };
                    req.user = {
                        id: String(row.discord_user_id),
                        username: row.discord_username,
                        avatar: row.avatar_url,
                        roles: Array.isArray(row.guild_roles) ? row.guild_roles.map(String) : []
                    };
                }
            } catch (error) {
                // A database blip must not log people out or crash the request.
                console.error("[session] lookup failed", error.message);
            }
        }

        res.setHeader("Cache-Control", "no-store");

        req.issueSession = async function issueSession(user) {
            const sid = crypto.randomBytes(32).toString("base64url");
            const exp = Date.now() + ttlMs;

            await store.query(
                "INSERT INTO web_sessions " +
                    "(id, discord_user_id, discord_username, avatar_url, guild_roles, expires_at) " +
                    "VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval)",
                [
                    sid,
                    user.id,
                    user.username || "",
                    user.avatar || null,
                    JSON.stringify(user.roles || []),
                    String(ttlMs)
                ]
            );

            res.cookie(cookieName, createToken({ sid, exp }, secret), {
                httpOnly: true,
                sameSite: "lax",
                secure,
                maxAge: ttlMs,
                path: "/"
            });

            req.session = { id: sid };
            req.user = user;
        };

        req.destroySession = async function destroySession() {
            if (req.session) {
                await store.query("DELETE FROM web_sessions WHERE id = $1", [req.session.id]);
            }

            res.clearCookie(cookieName, { path: "/" });
            req.session = null;
            req.user = null;
        };

        next();
    };
}

/** Guards routes that need a signed-in member. */
function requireUser(req, res, next) {
    if (!req.user) {
        return res.status(401).json({
            error: "not_signed_in",
            message: "Sign in with Discord to continue."
        });
    }

    return next();
}

module.exports = { sessionMiddleware, requireUser, createToken, readToken, SESSION_TTL_MS };
