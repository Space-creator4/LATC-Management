"use strict";

/**
 * Live role refresh for a signed-in member.
 *
 * The session row carries a copy of the member's guild roles, but that copy is
 * taken once, at sign in. A member who is promoted while signed in - the normal
 * path for a new pilot, whose role arrives only after staff approve their
 * application - would otherwise stay "not a pilot" until they sign out and back
 * in again. Until this existed, that was exactly why ATC applications were
 * unreachable: everyone who followed the intended journey was blocked.
 *
 * This asks Discord again, cheaply, every few minutes, and writes the freshest
 * answer back into the session row. Every open tab and every gated check then
 * sees the same current roles, and the account page's promise - permissions
 * change as soon as Discord does - finally holds.
 *
 * Failure behaviour matters: a Discord outage must not kick everyone out of
 * every gated UI. If the live call cannot be made, the last known roles (the
 * session snapshot) are returned instead. Only a member Discord genuinely says
 * has no roles is refused.
 */

/* Bound lazily so tests can hand in a stub without this module reading the real
   one at require() time, and so the config-supplied value cannot drift. */
const DEFAULT_DISCORD = require("./discord");

/** How long a freshly fetched role list is trusted before asking again. */
const CACHE_TTL_MS = 2 * 60 * 1000;

/* Module level on purpose: every request in this process for the same member
   shares one answer, so a page load storm is at most one Discord call per
   member per TTL, not one per request. */
const cache = new Map();

function clearCache() {
    cache.clear();
}

/**
 * Returns the roles that decide what the member may do, preferring a live read
 * of Discord and never inventing roles when that read fails.
 *
 *  - bot token or guild id not configured  -> session snapshot (as before)
 *  - fresh answer in cache under the TTL   -> that answer
 *  - live fetch succeeds                   -> fresh roles, persisted to the row
 *  - live fetch throws                     -> session snapshot (never "no roles")
 */
async function refreshMemberRoles({ store, config, user, discord = DEFAULT_DISCORD }) {
    const snapshot = user && Array.isArray(user.roles) ? user.roles.slice() : [];
    const id = user && user.id ? String(user.id) : "";

    if (
        !id ||
        !config ||
        !config.discord ||
        !config.discord.botToken ||
        !config.discord.guildId
    ) {
        return snapshot;
    }

    const now = Date.now();
    const cached = cache.get(id);

    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.roles;
    }

    let fresh;

    try {
        fresh = await discord.fetchMemberRoles({
            botToken: config.discord.botToken,
            guildId: config.discord.guildId,
            userId: id
        });
    } catch (error) {
        // Transient failure: keep the snapshot rather than guessing. A pilot is
        // worth more than a pessimistic first guess.
        console.warn("[memberRoles] live role lookup failed", error.message);
        return snapshot;
    }

    cache.set(id, { roles: fresh.slice(), fetchedAt: now });

    // Best effort: the session row is a cache, not the source of truth. If it
    // cannot be written the door has already opened for this request, and the
    // next request refreshes on its own.
    if (store && typeof store.query === "function") {
        try {
            await store.query(
                "UPDATE web_sessions SET guild_roles = $1 WHERE discord_user_id = $2",
                [JSON.stringify(fresh), id]
            );
        } catch (error) {
            console.warn("[memberRoles] could not persist refreshed roles", error.message);
        }
    }

    return fresh;
}

module.exports = { refreshMemberRoles, clearCache, CACHE_TTL_MS };