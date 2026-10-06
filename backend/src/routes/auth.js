"use strict";

const express = require("express");
const {
    authorizeUrl,
    exchangeCode,
    fetchUser,
    fetchGuildRoles,
    hasRole
} = require("../lib/discord");
const { requireUser } = require("../lib/session");

/**
 * Sign in with Discord.
 *
 * Flow: /auth/discord sends the browser to Discord for consent, Discord calls
 * back to /auth/discord/callback with a one-time code, the server swaps that for
 * a token to learn who the member is, reads their guild roles, and sets an
 * httpOnly session cookie.
 *
 * `state` is echoed through the round trip and compared on the way back. That
 * check is what stops an attacker from feeding a victim's callback URL a code
 * of their own and landing them in someone else's session.
 */

function createAuthRouter({ config }) {
    const router = express.Router();

    router.get("/discord", (req, res) => {
        // Derived from this server's own public origin so the callback can
        // never be pointed at the static site by mistake. An explicit
        // DISCORD_REDIRECT_URI overrides it, and must then exactly match a
        // redirect registered in the Discord developer portal.
        const redirectUri =
            config.discord.redirectUri || `${req.protocol}://${req.get("host")}/auth/discord/callback`;

        const state = require("node:crypto").randomBytes(24).toString("base64url");

        // Signed so it cannot be edited in flight, and short lived.
        req.stateCookie = state;
        res.cookie("latc_oauth_state", `${state}.${signState(state, config.session.secret)}`, {
            httpOnly: true,
            sameSite: "lax",
            secure: config.session.secure,
            maxAge: 10 * 60 * 1000,
            path: "/"
        });

        return res.redirect(authorizeUrl({
            clientId: config.discord.clientId,
            redirectUri,
            state
        }));
    });

    router.get("/discord/callback", async (req, res, next) => {
        try {
            const { code, state, error } = req.query;

            if (error) {
                return res.status(400).send("Sign in was declined or failed. No changes were made.");
            }

            if (!code) {
                return res.status(400).send("Missing authorisation code.");
            }

            const stored = req.cookies.latc_oauth_state;

            if (!stored || !state || stored !== `${state}.${signState(state, config.session.secret)}`) {
                return res.status(400).send("Sign in expired or could not be verified. Try again.");
            }

            res.clearCookie("latc_oauth_state", { path: "/" });

            const token = await exchangeCode({
                code,
                clientId: config.discord.clientId,
                clientSecret: config.discord.clientSecret,
                redirectUri: config.discord.redirectUri
            });

            const user = await fetchUser(token.access_token);
            const roles = await fetchGuildRoles({
                botToken: config.discord.botToken,
                guildId: config.discord.guildId,
                userId: user.id
            });

            await req.issueSession({ ...user, roles });

            return res.redirect(config.allowedOrigins[0] + "/account/?signed_in=1");
        } catch (err) {
            return next(err);
        }
    });

    router.post("/logout", requireUser, async (req, res, next) => {
        try {
            await req.destroySession();
            return res.json({ ok: true });
        } catch (err) {
            return next(err);
        }
    });

    /**
     * Who am I, and what may I do. The browser uses this to decide whether to
     * show the radar link, but every gated endpoint checks roles again.
     */
    router.get("/me", requireUser, (req, res) => {
        const { pilotRoleId, atcRoleId, staffRoleId } = config.discord;

        res.json({
            user: {
                id: req.user.id,
                username: req.user.username,
                avatar: req.user.avatar
            },
            permissions: {
                isPilot: hasRole(req.user.roles, pilotRoleId),
                isAtc: hasRole(req.user.roles, atcRoleId),
                isStaff: hasRole(req.user.roles, staffRoleId)
            },
            features: {
                applicationsOpen: {
                    pilot: true,
                    atc: config.applications.atcRequiresPilot ? "pilots_only" : true,
                    staff: config.applications.staffOpen
                },
                queueAutoApprove: config.queue.autoApprove
            }
        });
    });

    return router;
}

function signState(state, secret) {
    return require("node:crypto")
        .createHmac("sha256", secret)
        .update(state)
        .digest("base64url");
}

module.exports = { createAuthRouter };
