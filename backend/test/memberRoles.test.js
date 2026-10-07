"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { refreshMemberRoles, clearCache } = require("../src/lib/memberRoles");

const PILOT = "111111111111111111";

const config = {
    discord: {
        botToken: "bot-token",
        guildId: "999999999999999999",
        pilotRoleId: PILOT
    }
};

function configWithoutBotToken() {
    return {
        discord: {
            botToken: "",
            guildId: "999999999999999999",
            pilotRoleId: PILOT
        }
    };
}

function capturedStore() {
    const calls = [];
    return {
        calls,
        async query(text, params) {
            calls.push({ text, params });
            return { rows: [] };
        }
    };
}

test("returns the snapshot when no bot token is configured, touching nothing", async () => {
    clearCache();
    const discord = {
        fetchMemberRoles: async () => {
            throw new Error("should never be called without a bot token");
        }
    };
    const store = capturedStore();
    const user = { id: "1", roles: [PILOT] };

    const roles = await refreshMemberRoles({ store, config: configWithoutBotToken(), user, discord });

    assert.deepEqual(roles, [PILOT]);
    assert.equal(store.calls.length, 0);
});

test("returns the snapshot when the member has no id, even with a token", async () => {
    clearCache();
    const discord = {
        fetchMemberRoles: async () => {
            throw new Error("should never be called without a member id");
        }
    };
    const store = capturedStore();
    const user = { id: "", roles: [PILOT] };

    const roles = await refreshMemberRoles({ store, config, user, discord });

    assert.deepEqual(roles, [PILOT]);
    assert.equal(store.calls.length, 0);
});

test("fetches live roles and writes them back to the session row", async () => {
    clearCache();
    const fetchMemberRoles = async ({ userId }) => {
        assert.equal(userId, "42");
        return [PILOT, "222222222222222222"];
    };
    const store = capturedStore();
    const user = { id: "42", roles: [] };

    const roles = await refreshMemberRoles({ store, config, user, discord: { fetchMemberRoles } });

    assert.deepEqual(roles, [PILOT, "222222222222222222"]);

    assert.equal(store.calls.length, 1);
    const update = store.calls[0];
    assert.ok(update.text.includes("UPDATE web_sessions SET guild_roles"));
    assert.ok(update.text.includes("WHERE discord_user_id"));
    assert.deepEqual(JSON.parse(update.params[0]), [PILOT, "222222222222222222"]);
    assert.equal(update.params[1], "42");
});

test("a failed live lookup falls back to the snapshot and persists nothing", async () => {
    clearCache();
    const discord = {
        fetchMemberRoles: async () => {
            throw new Error("Discord is down");
        }
    };
    const store = capturedStore();
    const user = { id: "7", roles: [PILOT] };

    const roles = await refreshMemberRoles({ store, config, user, discord });

    assert.deepEqual(roles, [PILOT]);
    assert.equal(store.calls.length, 0, "nothing may be persisted from a failed lookup");
});

test("a cached answer is reused without asking Discord again", async () => {
    clearCache();
    let calls = 0;
    const discord = {
        fetchMemberRoles: async () => {
            calls += 1;
            return [PILOT];
        }
    };
    const store = capturedStore();
    const user = { id: "9", roles: [] };

    const first = await refreshMemberRoles({ store, config, user, discord });
    const second = await refreshMemberRoles({ store, config, user, discord });

    assert.deepEqual(first, [PILOT]);
    assert.deepEqual(second, [PILOT]);
    assert.equal(calls, 1);
    assert.equal(store.calls.length, 1, "the row is updated once per import cycle too");
});