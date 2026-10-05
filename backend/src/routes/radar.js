"use strict";

const express = require("express");
const { hasRole } = require("../lib/discord");
const { requireUser } = require("../lib/session");

/**
 * Radar.
 *
 * Controllers only. Every request re-checks the member's ATC role server side, so
 * hiding the page link is presentation rather than the actual control. A pilot who
 * is not also an ATC controller gets 403 whether or not they guessed the URL.
 *
 * The response is deliberately a sector skeleton with no live traffic yet. Fields
 * for traffic arrive when a real feed exists; until then nothing is invented.
 */

const SECTORS = [
    { id: "ground", name: "Ground", callsign: "LATC Ground", frequency: "120.100" },
    { id: "local", name: "Local / Tower", callsign: "LATC Tower", frequency: "118.700" },
    { id: "approach", name: "Approach", callsign: "LATC Approach", frequency: "124.350" }
];

function createRadarRouter({ config }) {
    const router = express.Router();

    function requireAtc(req, res, next) {
        if (!hasRole(req.user.roles, config.discord.atcRoleId)) {
            return res.status(403).json({
                error: "atc_only",
                message: "Radar is available to approved ATC controllers."
            });
        }

        return next();
    }

    router.get("/", requireUser, requireAtc, (req, res) => {
        res.json({
            available: true,
            feed: "pending",
            notice: "Sector layout only. Live traffic is not connected yet.",
            sectors: SECTORS,
            positions: []
        });
    });

    /** Summary used by the page to say whether the feed is live yet. */
    router.get("/status", requireUser, requireAtc, (req, res) => {
        res.json({ available: true, feed: "pending", sectorCount: SECTORS.length });
    });

    return router;
}

module.exports = { createRadarRouter, SECTORS };
