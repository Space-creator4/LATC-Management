/* ==========================================================================
   Latitude ATC — site configuration
   --------------------------------------------------------------------------
   This is the ONLY place external URLs are defined. Every page reads these
   values through data-config attributes (see assets/js/main.js), so you never
   need to edit the HTML to change a link.

   Any value still containing REPLACE- is treated as "not set yet". Links bound
   to those values render with a dashed outline, are skipped when a visitor
   activates them, and the console lists what still needs filling in.

   Relative page links (Home, About, Rules, ...) are intentionally NOT here —
   they are internal and must keep working without configuration.
   ========================================================================== */

window.LATC_CONFIG = Object.freeze({

    /* ---- Backend --------------------------------------------------------- */

    /**
     * Base URL of the Render service that serves the API, without a trailing
     * slash. Everything else is built from it:
     *
     *   <apiBaseUrl>/auth/discord
     *   <apiBaseUrl>/api/applications
     *   <apiBaseUrl>/api/queue/join
     *   <apiBaseUrl>/api/radar
     *
     * While this is a placeholder the site still works: sign in is disabled,
     * and applications, the queue, and Radar each explain that the service is
     * not connected yet instead of failing silently.
     *
     * Secrets do not belong on this page. The Discord client secret, the bot
     * token, the database URL, and the private server invite all live in the
     * service's environment, never here.
     */
    apiBaseUrl: "https://REPLACE-WITH-RENDER-SERVICE-URL.onrender.com",

    /* ---- Community links ------------------------------------------------ */

    /** Discord server invite. */
    discordInvite: "https://discord.gg/pDWhZnJe8x",

    /** Latitude ATC experience on Roblox (game page). */
    robloxGameUrl: "https://www.roblox.com/games/REPLACE-WITH-LATC-GAME-ID",

    /** Roblox group / official profile, if one exists. */
    robloxGroupUrl: "https://www.roblox.com/communities/665836232/AervionX#!/about",

    /* ---- Rules ---------------------------------------------------------- */

    /** Full rulebook document (PDF / Google Doc / Notion page). */
    rulebookUrl: "https://REPLACE-WITH-FULL-RULEBOOK-URL",

    /* ---- Contact -------------------------------------------------------- */

    /** Public contact address. Replace with the real address, or leave the placeholder. */
    contactEmail: "mailto:support@latc.co.uk",

    /* ---- Statistics ----------------------------------------------------- */

    /**
     * Optional JSON endpoint that returns community figures.
     * Expected shape (any subset of keys is fine):
     *
     *   { "members": 0, "controllers": 0, "pilots": 0, "operations": 0 }
     *
     * While this is null the statistics section shows a neutral placeholder
     * rather than an invented number. Do not hard-code figures here.
     */
    statsApiUrl: null
});
