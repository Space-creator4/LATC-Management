/* ==========================================================================
   Latitude ATC — api.js
   Config access, the API client, and session state.

   Exposed as window.LATC so the page modules can share one session lookup
   instead of each calling /auth/me.

   The session is an httpOnly cookie, so it cannot be read from JavaScript. Every
   request therefore sends credentials, and "am I signed in" is always answered by
   the server rather than assumed.
   ========================================================================== */
(function () {
    "use strict";

    var config = window.LATC_CONFIG || {};

    var isPlaceholder = function (value) {
        return !value || /REPLACE|TODO|example\.com/i.test(value);
    };

    var apiBase = function () {
        var base = config.apiBaseUrl;
        return typeof base === "string" && !isPlaceholder(base) ? base.replace(/\/+$/, "") : "";
    };

    var hasApi = function () {
        return apiBase() !== "";
    };

    /** Error objects carry the status and machine code so callers can branch. */
    function ApiError(message, status, code, errors) {
        this.name = "ApiError";
        this.message = message || "Something went wrong.";
        this.status = status || 0;
        this.code = code || null;
        this.errors = errors || null;
    }
    ApiError.prototype = Object.create(Error.prototype);

    function apiRequest(path, options) {
        var settings = options || {};
        var base = apiBase();

        if (!base) {
            return Promise.reject(new ApiError("This site is not connected to the API yet.", 0, "no_api"));
        }

        var headers = { Accept: "application/json" };

        if (settings.body) {
            headers["Content-Type"] = "application/json";
        }

        return fetch(base + path, {
            method: settings.method || "GET",
            credentials: "include",
            headers: headers,
            body: settings.body ? JSON.stringify(settings.body) : undefined
        })
            .then(function (response) {
                return response
                    .json()
                    .catch(function () {
                        return {};
                    })
                    .then(function (data) {
                        if (!response.ok) {
                            throw new ApiError(
                                data.message || "Something went wrong (" + response.status + ").",
                                response.status,
                                data.error,
                                data.errors
                            );
                        }
                        return data;
                    });
            })
            .catch(function (error) {
                /* A network failure, a CORS rejection, or the API being down all
                   arrive here. Report them as an ApiError so callers have one
                   error type to handle. */
                if (error instanceof ApiError) {
                    throw error;
                }
                throw new ApiError(
                    "We could not reach the service. Check your connection and try again.",
                    0,
                    "network"
                );
            });
    }

    /* ------------------------------------------------------------------
       Session
       ------------------------------------------------------------------ */
    var session = null;
    var listeners = [];

    function onSessionChange(callback) {
        listeners.push(callback);
        callback(session);
    }

    function notify() {
        listeners.forEach(function (callback) {
            try {
                callback(session);
            } catch (error) {
                console.error("[latc] session listener failed", error);
            }
        });
    }

    function isSignedIn() {
        return Boolean(session && session.user);
    }

    function hasPermission(key) {
        return Boolean(session && session.permissions && session.permissions[key]);
    }

    /** Resolves with the session, or null when signed out. Never rejects. */
    function loadSession() {
        if (!hasApi()) {
            session = null;
            notify();
            return Promise.resolve(null);
        }

        return apiRequest("/auth/me")
            .then(function (data) {
                session = data;
                notify();
                return data;
            })
            .catch(function () {
                /* 401 is the normal signed-out answer, not a failure worth
                   logging. Anything else lands here too, and being treated as
                   signed out is the safe reading. */
                session = null;
                notify();
                return null;
            });
    }

    function signOut() {
        return apiRequest("/auth/logout", { method: "POST" })
            .catch(function () {
                /* Even if the call fails, clear local state and reload: the goal
                   is that the browser stops treating this as signed in. */
            })
            .then(function () {
                session = null;
                notify();
                window.location.reload();
            });
    }

    window.LATC = {
        config: config,
        isPlaceholder: isPlaceholder,
        apiBase: apiBase,
        hasApi: hasApi,
        apiRequest: apiRequest,
        ApiError: ApiError,
        session: function () {
            return session;
        },
        isSignedIn: isSignedIn,
        hasPermission: hasPermission,
        onSessionChange: onSessionChange,
        loadSession: loadSession,
        signOut: signOut
    };
})();
