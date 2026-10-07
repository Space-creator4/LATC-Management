"use strict";

const express = require("express");
const { requireUser } = require("../lib/session");
const { refreshMemberRoles } = require("../lib/memberRoles");

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

function createAuthRouter({ config, discord = require("../lib/discord") }) {
    const router = express.Router();
    const { authorizeUrl, exchangeCode, fetchUser, fetchGuildRoles, hasRole } = discord;

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

            /* Carry the session back to the static site as a URL fragment
               (#token=...). Fragments never leave the browser, so nothing is
               written to server logs, and the site sends it as a Bearer header
               on later calls because the session cookie is blocked by modern
               browsers on cross-site fetches. */
            const sessionToken = req.session && req.session.token ? "#token=" + req.session.token : "";

            return res.redirect(config.allowedOrigins[0] + "/account/?signed_in=1" + sessionToken);
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
     *
     * Roles come from a live read of Discord rather than the login snapshot, so
     * a promotion shows up in the nav and on the account page without a sign
     * in/out cycle.
     */
    router.get("/me", requireUser, async (req, res, next) => {
        try {
            const { pilotRoleId, atcRoleId, staffRoleId } = config.discord;
            const roles = await refreshMemberRoles({
                store: req.store,
                config,
                user: req.user,
                discord
            });

            res.json({
                user: {
                    id: req.user.id,
                    username: req.user.username,
                    avatar: req.user.avatar
                },
                permissions: {
                    isPilot: hasRole(roles, pilotRoleId),
                    isAtc: hasRole(roles, atcRoleId),
                    isStaff: hasRole(roles, staffRoleId)
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
        } catch (err) {
            return next(err);
        }
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
