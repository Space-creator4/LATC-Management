/* ==========================================================================
   Latitude ATC — auth.js
   Reflects session state in the page: sign in / sign out buttons, the member's
   name, and links that only make sense for certain roles.

   Elements opt in with data attributes:

     data-auth="signed-in"     shown only when someone is signed in
     data-auth="signed-out"    shown only when signed out
     data-auth-username        filled with the member's display name
     data-auth-permission="isAtc"   shown only to members with that permission
     data-auth-signin          href is pointed at the OAuth start on the API
     data-auth-signout         becomes a button that ends the session

   Hiding a radar link is presentation. The API checks the ATC role again on every
   request, so hiding it here is a courtesy rather than the control.
   ========================================================================== */
(function () {
    "use strict";

    var api = window.LATC;

    if (!api) {
        return;
    }

    /* ------------------------------------------------------------------
       Toast
       A small status strip used for sign in / sign out feedback that would
       otherwise be invisible on pages without an obvious notice area.
       ------------------------------------------------------------------ */
    function toast(message) {
        var existing = document.querySelector(".latc-toast");

        if (existing) {
            existing.remove();
        }

        var el = document.createElement("div");
        el.className = "latc-toast";
        el.setAttribute("role", "status");
        el.textContent = message;
        document.body.appendChild(el);

        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                el.classList.add("is-visible");
            });
        });

        window.setTimeout(function () {
            el.classList.remove("is-visible");
            window.setTimeout(function () {
                el.remove();
            }, 300);
        }, 4000);
    }

    /* Welcome back from the OAuth round trip. The callback lands here with
       ?signed_in=1 once every page on the site now agrees who you are. */
    var params = new URLSearchParams(window.location.search);
    var welcomed = params.get("signed_in") === "1";

    if (welcomed) {
        api.onSessionChange(function (session) {
            if (welcomed && session && session.user) {
                welcomed = false;
                toast("You're signed in as " + session.user.username + ".");
            }
        });
    }

    /* Tell the next page load (created by signOut) that it should confirm the
       logout out loud, and clean the marker off the address bar. */
    var signedOutFlag = "latc-signed-out";
    var hadSignedOut = false;

    try {
        hadSignedOut = sessionStorage.getItem(signedOutFlag) === "1";
        sessionStorage.removeItem(signedOutFlag);
    } catch (error) {
        /* Storage blocked; the sign out itself still works. */
    }

    if (hadSignedOut) {
        api.onSessionChange(function (session) {
            if (hadSignedOut && !session) {
                hadSignedOut = false;
                toast("You've been signed out.");
            }
        });
    }

    if (welcomed) {
        window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }

    function paint(session) {
        var signedIn = Boolean(session && session.user);

        document.querySelectorAll("[data-auth]").forEach(function (el) {
            var wantsSignedIn = el.getAttribute("data-auth") === "signed-in";

            /* An element with no data-auth value is always shown. */
            el.hidden = wantsSignedIn !== signedIn;
        });

        document.querySelectorAll("[data-auth-username]").forEach(function (el) {
            el.textContent = session && session.user ? session.user.username : "";
        });

        document.querySelectorAll("[data-auth-permission]").forEach(function (el) {
            var key = el.getAttribute("data-auth-permission");
            el.hidden = !api.hasPermission(key);
        });

        /* Once the session has actually resolved there is nothing left to
           wait for, so the loading card steps out of the way. */
        document.querySelectorAll("[data-account-pending]").forEach(function (el) {
            el.hidden = true;
        });

        document.querySelectorAll("[data-auth-avatar]").forEach(function (el) {
            var avatar = session && session.user && session.user.avatar;

            if (avatar) {
                el.setAttribute("src", avatar);
                el.hidden = false;
            } else {
                el.hidden = true;
            }
        });

        /* Sign-in links have to point at the API, which runs the OAuth round trip
           and sets the cookie. Without an API there is nowhere to send anyone, so
           the link is disabled rather than left pointing at nothing. */
        document.querySelectorAll("[data-auth-signin]").forEach(function (el) {
            if (api.hasApi()) {
                el.setAttribute("href", api.apiBase() + "/auth/discord");
                el.classList.remove("is-unconfigured");
                el.removeAttribute("aria-disabled");
                el.removeAttribute("title");
            } else {
                el.setAttribute("href", "#");
                el.classList.add("is-unconfigured");
                el.setAttribute("aria-disabled", "true");
                el.setAttribute("title", "Set apiBaseUrl in assets/js/config.js to enable sign in.");
            }
        });
    }

    document.querySelectorAll("[data-auth-signout]").forEach(function (button) {
        button.addEventListener("click", function () {
            button.disabled = true;

            try {
                sessionStorage.setItem(signedOutFlag, "1");
            } catch (error) {
                /* Storage blocked; the sign out itself still works. */
            }

            api.signOut();
        });
    });

    api.onSessionChange(paint);
    api.loadSession();
})();
