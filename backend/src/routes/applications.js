"use strict";

const express = require("express");
const { loadSchema, validateSubmission } = require("../lib/schemas");
const { hasRole } = require("../lib/discord");
const { refreshMemberRoles } = require("../lib/memberRoles");
const { requireUser } = require("../lib/session");

/**
 * Application intake.
 *
 * Sign in is required. Every rule that matters is checked here rather than in the
 * browser:
 *
 *   - staff is refused unless APPLICATIONS_STAFF_OPEN is set, so a stale cached
 *     page cannot reopen intake
 *   - atc is refused unless the applicant's own Discord account already holds the
 *     pilot role, checked live rather than against the login-time snapshot so a
 *     member promoted after signing in is not locked out
 *   - fields are validated against the same JSON the form was rendered from
 *
 * A client that skips the gate, edits the payload, or forges the session is still
 * refused, because none of those change what this code checks.
 */

function createApplicationsRouter({ config, discord = require("../lib/discord") }) {
    const router = express.Router();

    router.post("/", requireUser, async (req, res, next) => {
        try {
            const role = String((req.body && req.body.role) || "").trim();

            if (!/^(pilot|atc|staff)$/.test(role)) {
                return res.status(400).json({
                    error: "unknown_role",
                    message: "role must be one of pilot, atc, staff."
                });
            }

            /*
             * Staff intake is closed if either the server switch says so or the
             * question set is still marked closed. Reopening therefore takes both:
             * set APPLICATIONS_STAFF_OPEN=true and give the staff question set its
             * questions back. Requiring both means a stale cached page cannot
             * reopen intake on its own.
             */
            const schema = loadSchema(role);
            const staffClosed = !config.applications.staffOpen || schema.closed === true;

            if (role === "staff" && staffClosed) {
                return res.status(403).json({
                    error: "staff_closed",
                    message: "Staff applications are closed. Staff roles open in batches, announced in Discord."
                });
            }

            if (role === "atc" && config.applications.atcRequiresPilot) {
                /* Live, not the login snapshot: a member who becomes a pilot
                   after signing in (the normal flow) must not be blocked here. */
                const roles = await refreshMemberRoles({
                    store: req.store,
                    config,
                    user: req.user,
                    discord
                });
                const isPilot = hasRole(roles, config.discord.pilotRoleId);

                if (!isPilot) {
                    return res.status(403).json({
                        error: "not_a_pilot",
                        message: "ATC applications are for accepted Latitude ATC pilots only. Apply as a pilot first."
                    });
                }
            }

            const result = validateSubmission(schema, req.body);

            if (!result.ok) {
                return res.status(422).json({
                    error: "invalid_submission",
                    message: "Some answers need attention.",
                    errors: result.errors
                });
            }

            /*
             * The Discord identity comes from the session, never from the body, so
             * a submission cannot be filed under someone else's name. The
             * client's claimed handle is kept only as a convenience for staff.
             */
            const record = {
                role,
                discordUserId: req.user.id,
                discordUsername: req.body.discordUsername || req.user.username,
                values: result.values
            };

            const inserted = await req.store.query(
                "INSERT INTO web_applications (role, discord_user_id, discord_username, payload) " +
                    "VALUES ($1, $2, $3, $4) RETURNING id",
                [
                    role,
                    record.discordUserId,
                    record.discordUsername,
                    JSON.stringify({
                        ...record.values,
                        source: typeof req.body.source === "string" ? req.body.source : "latc-website",
                        submittedAt:
                            typeof req.body.submittedAt === "string"
                                ? req.body.submittedAt
                                : new Date().toISOString(),
                        discordAccount: {
                            id: req.user.id,
                            username: req.user.username
                        }
                    })
                ]
            );

            return res.status(201).json({
                ok: true,
                id: String(inserted.rows[0].id),
                role,
                message:
                    role === "atc"
                        ? "ATC application received. Staff will confirm your pilot status and reply on Discord."
                        : "Application received. Staff will review it and contact you, so keep an eye on your Discord messages."
            });
        } catch (error) {
            return next(error);
        }
    });

    /** Lets a signed-in member see their own submissions. Staff see their own too. */
    router.get("/", requireUser, async (req, res, next) => {
        try {
            const result = await req.store.query(
                "SELECT id, role, status, created_at FROM web_applications " +
                    "WHERE discord_user_id = $1 ORDER BY created_at DESC LIMIT 25",
                [req.user.id]
            );

            return res.json({
                applications: result.rows.map((row) => ({
                    id: String(row.id),
                    role: row.role,
                    status: row.status,
                    createdAt: row.created_at
                }))
            });
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = { createApplicationsRouter };
