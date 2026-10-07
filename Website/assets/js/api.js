/* ==========================================================================
   Latitude ATC — api.js
   Config access, the API client, and session state.

   Exposed as window.LATC so the page modules can share one session lookup
   instead of each calling /auth/me.

   The session is an httpOnly cookie, so it cannot be read from JavaScript. But
   the site and the API live on different sites, so browsers that block
   third-party cookies never attach it to a cross-site fetch. The OAuth callback
   therefore also hands this page the session as "#token=..." in the URL, which
   is stashed here and sent back as an Authorization: Bearer header. Every
   request still uses credentials too, so browsers that allow the cookie keep
   working untouched. "Am I signed in" is always answered by the server.
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

    /* ------------------------------------------------------------------
       Bearer token
       The OAuth callback returns to the site as /account/?signed_in=1#token=...
       The token is stashed in localStorage so every page and every open tab
       signs itself into the same session, and sent as an Authorization header
       on each call. It expires with the session, so it is only ever useful as
       long as the account itself, and signing out throws it away.
       ------------------------------------------------------------------ */
    var TOKEN_KEY = "latc-token";

    function getToken() {
        try {
            return localStorage.getItem(TOKEN_KEY) || null;
        } catch (error) {
            return null;
        }
    }

    function setToken(token) {
        try {
            if (token) {
                localStorage.setItem(TOKEN_KEY, token);
            } else {
                localStorage.removeItem(TOKEN_KEY);
            }
        } catch (error) {
            /* Storage blocked; the cookie path still works where the browser
               allows it. */
        }
    }

    /* Pulls #token=... out of the address bar, keeps it, and cleans the
       fragment away so a refresh or share does not carry it around. Runs on
       every session load so the order the page scripts run never matters. */
    function captureTokenFromHash() {
        var match = (window.location.hash || "").match(/[#&]token=([^&]+)/);

        if (match && match[1]) {
            setToken(decodeURIComponent(match[1]));
            window.history.replaceState({}, "", window.location.pathname + window.location.search);
        }
    }

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

        var token = getToken();

        if (token) {
            headers["Authorization"] = "Bearer " + token;
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

    /*
     * Session cache. The cookie is httpOnly so a page cannot read the actual
     * session, but the /auth/me payload (name, avatar, roles) is safe to keep
     * around: it is exactly what the page would render anyway, and every page
     * revalidates it against the server before trusting it.
     *
     *   sessionStorage   instant paint on this tab (no signed-out flash)
     *   localStorage     syncs the state across every open tab via "storage"
     */
    var SESSION_CACHE = "latc-session";

    function cacheRead() {
        try {
            var raw = sessionStorage.getItem(SESSION_CACHE);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            return null;
        }
    }

    function cacheWrite(cached) {
        var raw = cached ? JSON.stringify(cached) : "";

        /* Skip writes that change nothing. Without this, two tabs both seeing a
           signed-out answer keep nudging each other's "storage" listener until
           every tab has re-fetched /auth/me. */
        if (raw === cacheWrite.last) {
            return;
        }

        cacheWrite.last = raw;

        try {
            if (raw) {
                sessionStorage.setItem(SESSION_CACHE, raw);
                localStorage.setItem(SESSION_CACHE, raw);
            } else {
                sessionStorage.removeItem(SESSION_CACHE);
                localStorage.removeItem(SESSION_CACHE);
            }
        } catch (error) {
            /* Storage can be blocked entirely; the session still works, it just
               falls back to a per-page check. */
        }
    }

    /* A returning visitor is painted signed in straight from cache, then the
       server is asked for the truth. */
    var cached = cacheRead();

    if (cached) {
        session = cached;
        notify();
    }

    /* A sign in or out anywhere keeps every open tab honest: another tab's
       change lands here as a "storage" event, and a back/forward navigation
       rechecks too because those pages are restored, not reloaded. */
    window.addEventListener("storage", function (event) {
        if (event.key === SESSION_CACHE) {
            loadSession();
        }
    });

    window.addEventListener("pageshow", function (event) {
        if (event.persisted) {
            loadSession();
        }
    });

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
        captureTokenFromHash();

        if (!hasApi()) {
            session = null;
            cacheWrite(null);
            notify();
            return Promise.resolve(null);
        }

        return apiRequest("/auth/me")
            .then(function (data) {
                session = data;
                cacheWrite(data);
                notify();
                return data;
            })
            .catch(function () {
                /* 401 is the normal signed-out answer, not a failure worth
                   logging. Anything else lands here too, and being treated as
                   signed out is the safe reading. A rejected token is dead too,
                   so stop carrying it. */
                session = null;
                setToken(null);
                cacheWrite(null);
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
                setToken(null);
                cacheWrite(null);
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
