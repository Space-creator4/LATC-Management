"use strict";

/**
 * A store double with the same shape as the real one.
 *
 * Routes take the store from req.store and call query() with (sql, params). The
 * tests assert on the SQL that was issued rather than on a live Postgres, which
 * keeps them fast and lets them cover the paths that must fail.
 */
class FakeStore {
    constructor(responses = {}) {
        this.calls = [];
        this.responses = responses;
    }

    async query(text, params = []) {
        this.calls.push({ text, params });
        const flat = text.replace(/\s+/g, " ").trim();

        for (const [pattern, reply] of Object.entries(this.responses)) {
            if (flat.includes(pattern)) {
                return typeof reply === "function" ? reply(flat, params) : reply;
            }
        }

        return { rows: [] };
    }

    issued(pattern) {
        return this.calls.filter((call) => call.text.replace(/\s+/g, " ").includes(pattern));
    }
}

const rows = (list) => ({ rows: list, rowCount: list.length });

module.exports = { FakeStore, rows };
