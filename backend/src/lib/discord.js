"use strict";

/**
 * Discord OAuth2 (login with Discord) and role lookups.
 *
 * Two separate flows use two separate tokens, on purpose:
 *
 *   - OAuth2, with the bot's client id and the member's consent. Used to sign a
 *     member in. The client secret stays in this process and never reaches the
 *     browser.
 *   - The bot token, used only to read the member's roles in the guild. This is
 *     a server-to-server call and involves no user consent.
 *
 * Role checks are what make "ATC only" and "pilots only" real. Nothing the
 * browser sends can stand in for them.
 */

const DISCORD_API = "https://discord.com/api/v10";
const OAUTH_SCOPES = ["identify", "guilds.members.read"];

function randomState() {
    return require("node:crypto").randomBytes(24).toString("base64url");
}

async function discordFetch(url, { token, method = "GET", body }) {
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Discord ${response.status}: ${detail.slice(0, 200)}`);
    }

    return response.status === 204 ? null : response.json();
}

/** Builds the URL the browser is sent to in order to grant consent. */
function authorizeUrl({ clientId, redirectUri, state }) {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPES.join(" ")
    });

    if (state) {
        params.set("state", state);
    }

    return `${DISCORD_API}/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchanges the callback code for an access token. The client secret is only
 * ever sent here, server to Discord.
 */
async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
    });

    const response = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
        },
        body: params.toString()
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Discord token exchange failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    return response.json();
}

/** Identity of the member who just consented. */
async function fetchUser(accessToken) {
    const user = await discordFetch(`${DISCORD_API}/users/@me`, { token: accessToken });

    return {
        id: String(user.id),
        username: user.global_name || user.username,
        avatar: user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
            : null
    };
}

/**
 * Role ids the member holds in the guild, read with the bot token. Throws on
 * any error, so a caller can tell "the member has no roles" apart from "the
 * check could not be made". Most callers want the lenient fetchGuildRoles
 * instead, which turns failures into "no roles"; this variant exists for the
 * rare path that must fall back to something rather than a guessed empty list.
 */
async function fetchMemberRoles({ botToken, guildId, userId }) {
    const member = await discordFetch(
        `${DISCORD_API}/guilds/${guildId}/members/${userId}`,
        { token: botToken }
    );

    return (member.roles || []).map(String);
}

/**
 * Roles the member holds in the guild, read with the bot token.
 *
 * Returns an empty array rather than throwing when the guild, role id, or bot
 * token is not configured, so a missing optional setting does not take the site
 * down. Callers that gate on roles treat "no roles" as "not a member", which
 * fails closed.
 */
async function fetchGuildRoles({ botToken, guildId, userId }) {
    if (!botToken || !guildId) {
        return [];
    }

    try {
        return await fetchMemberRoles({ botToken, guildId, userId });
    } catch (error) {
        // The bot must share the guild with the member for this to work. If it
        // cannot see them they are not in the guild, so no roles is correct.
        console.warn("[discord] role lookup failed", error.message);
        return [];
    }
}

function hasRole(roles, roleId) {
    return Boolean(roleId) && Array.isArray(roles) && roles.map(String).includes(String(roleId));
}

module.exports = {
    OAUTH_SCOPES,
    authorizeUrl,
    exchangeCode,
    fetchUser,
    fetchMemberRoles,
    fetchGuildRoles,
    hasRole,
    discordFetch
};
