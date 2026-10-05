/* ==========================================================================
   Latitude ATC — queue.js
   The Join page queue.

   The private server invite is never present in this page, the config, or any
   asset. It lives only in the service's environment, and the service hands it
   back after approving a join. That is what makes the queue worth having: the
   link cannot be read out of the site.
   ========================================================================== */
(function () {
    "use strict";

    var api = window.LATC;
    var container = document.querySelector("[data-queue]");

    if (!api || !container) {
        return;
    }

    var joinButton = container.querySelector("[data-queue-join]");
    var leaveButton = container.querySelector("[data-queue-leave]");
    var statusBox = container.querySelector("[data-queue-status]");
    var positionBox = container.querySelector("[data-queue-position]");
    var inviteBox = container.querySelector("[data-queue-invite]");
    var viewBox = container.querySelector("[data-queue-view]");
    var signInBox = container.querySelector("[data-queue-signin]");

    function view(name) {
        if (viewBox) {
            viewBox.hidden = name !== "view";
        }
        [signInBox, positionBox, inviteBox].forEach(function (box) {
            if (box) {
                box.hidden = true;
            }
        });
    }

    function show(name, position, inviteUrl) {
        view("none");

        /* A successful status check clears the previous complaint, otherwise a
           one-off failure would sit on the page saying the queue is broken
           after it had already recovered. */
        if (statusBox) {
            statusBox.hidden = true;
        }

        if (name === "view") {
            /* Signed in and not waiting: this is the only state that offers the
               request button, so it must actually be unhidden. */
            view("view");
        }

        if (name === "signed-out" && signInBox) {
            signInBox.hidden = false;
        }
        if (name === "waiting" && positionBox) {
            positionBox.hidden = false;
            var count = positionBox.querySelector("[data-queue-count]");

            if (count) {
                count.textContent = String(position);
            }
        }
        if (name === "invite" && inviteBox) {
            inviteBox.hidden = false;

            var link = inviteBox.querySelector("[data-invite-link]");

            if (link && inviteUrl) {
                link.setAttribute("href", inviteUrl);
            }
        }
    }

    function fail(message) {
        if (statusBox) {
            statusBox.hidden = false;
            statusBox.textContent = message;
        }
        if (joinButton) {
            joinButton.disabled = false;
        }
    }

    function refresh() {
        if (!api.hasApi()) {
            show("signed-out");
            fail("The queue is not connected to a service yet.");
            return;
        }

        api.apiRequest("/api/queue/status")
            .then(function (status) {
                if (status.inQueue) {
                    show("waiting", status.position);
                } else if (status.inviteUrl) {
                    show("invite", null, status.inviteUrl);
                } else {
                    show("view");
                }
            })
            .catch(function (error) {
                if (error.code === "unauthenticated") {
                    show("signed-out");
                } else {
                    show("none");
                    fail(error.message || "We could not check the queue just now.");
                }
            });
    }

    if (joinButton) {
        joinButton.addEventListener("click", function () {
            if (!api.hasApi()) {
                fail("The queue is not connected to a service yet.");
                return;
            }

            joinButton.disabled = true;

            api.apiRequest("/api/queue/join", { method: "POST" })
                .then(function (result) {
                    joinButton.disabled = false;

                    if (result.inviteUrl) {
                        show("invite", null, result.inviteUrl);
                    } else {
                        show("waiting", result.position);
                    }
                })
                .catch(function (error) {
                    joinButton.disabled = false;

                    if (error.code === "unauthenticated") {
                        show("signed-out");
                        fail("Sign in with Discord to join the queue.");
                    } else if (error.code === "network") {
                        fail("We could not reach the service. Check your connection and try again.");
                    } else {
                        fail(error.message || "We could not add you to the queue.");
                    }
                });
        });
    }

    if (leaveButton) {
        leaveButton.addEventListener("click", function () {
            leaveButton.disabled = true;

            api.apiRequest("/api/queue/leave", { method: "POST" })
                .then(function () {
                    leaveButton.disabled = false;
                    show("none");
                })
                .catch(function (error) {
                    leaveButton.disabled = false;
                    fail(error.message || "We could not take you out of the queue.");
                });
        });
    }

    api.onSessionChange(function (session) {
        if (session && session.user) {
            refresh();
        } else {
            show("signed-out");
        }
    });

    refresh();
})();
