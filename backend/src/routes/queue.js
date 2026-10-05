"use strict";

const express = require("express");
const { requireUser } = require("../lib/session");

/**
 * Join queue.
 *
 * A member signs in, accepts the rules, and gets a place in the queue. Once the
 * entry is approved the server returns the private server invite.
 *
 * The invite lives only in the server's PRIVATE_INVITE_URL and is written into
 * the response for that one approved member. It is never in a page, a JSON file,
 * or any file under Website/assets, because anything there is public and would
 * make the queue pointless: anyone could read the link and skip the queue.
 */

function createQueueRouter({ config }) {
    const router = express.Router();

    /** Join or rejoin. Safe to call twice: an open entry is returned unchanged. */
    router.post("/join", requireUser, async (req, res, next) => {
        try {
            const acceptedRules = req.body && req.body.agreedRules === true;

            if (!acceptedRules) {
                return res.status(422).json({
                    error: "rules_not_accepted",
                    message: "You need to accept the rules before joining the queue."
                });
            }

            const existing = await req.store.query(
                "SELECT id, status, position, created_at FROM web_queue_entries " +
                    "WHERE discord_user_id = $1 AND status IN ('pending', 'approved') " +
                    "ORDER BY created_at DESC LIMIT 1",
                [req.user.id]
            );

            if (existing.rows.length) {
                return res.status(200).json(respond(existing.rows[0], config));
            }

            const position = await nextPosition(req.store);

            const inserted = await req.store.query(
                "INSERT INTO web_queue_entries " +
                    "(discord_user_id, discord_username, status, position) " +
                    "VALUES ($1, $2, $3, $4) RETURNING id, status, position, created_at",
                [
                    req.user.id,
                    req.user.username,
                    config.queue.autoApprove ? "approved" : "pending",
                    position
                ]
            );

            if (config.queue.autoApprove) {
                await req.store.query(
                    "UPDATE web_queue_entries SET resolved_at = now() WHERE id = $1",
                    [inserted.rows[0].id]
                );
            }

            return res.status(201).json(respond(inserted.rows[0], config));
        } catch (error) {
            return next(error);
        }
    });

    /** Current place, and the invite once approved. */
    router.get("/status", requireUser, async (req, res, next) => {
        try {
            const result = await req.store.query(
                "SELECT id, status, position, created_at FROM web_queue_entries " +
                    "WHERE discord_user_id = $1 ORDER BY created_at DESC LIMIT 1",
                [req.user.id]
            );

            if (!result.rows.length) {
                return res.json({ inQueue: false, status: null });
            }

            return res.json({ inQueue: true, ...respond(result.rows[0], config) });
        } catch (error) {
            return next(error);
        }
    });

    /** Leave the queue, so a pending entry can be taken again later. */
    router.post("/leave", requireUser, async (req, res, next) => {
        try {
            await req.store.query(
                "UPDATE web_queue_entries SET status = 'cancelled', resolved_at = now() " +
                    "WHERE discord_user_id = $1 AND status = 'pending'",
                [req.user.id]
            );

            return res.json({ ok: true });
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

/**
 * The invite is attached only on approval. A pending entry gets its position and
 * nothing else.
 */
function respond(row, config) {
    const body = {
        id: String(row.id),
        status: row.status,
        position: row.position,
        queuedAt: row.created_at,
        autoApprove: config.queue.autoApprove
    };

    if (row.status === "approved") {
        body.inviteUrl = config.queue.privateInviteUrl;
    } else {
        body.message = "You are in the queue. You will be given the server link here once you are approved.";
    }

    return body;
}

/**
 * 1 based place in line, counting everyone still waiting. Uses a single query so
 * two people joining at once cannot both take the same number.
 */
async function nextPosition(store) {
    const result = await store.query(
        "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM web_queue_entries WHERE status = 'pending'"
    );

    return Number(result.rows[0].next) || 1;
}

module.exports = { createQueueRouter, respond, nextPosition };
