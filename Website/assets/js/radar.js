/* ==========================================================================
   Latitude ATC — radar.js
   Draws the sector layout returned by /api/radar.

   The layout is fixed: these sectors will not move when a controller logs in or
   out. Only the positions inside them change, and only for members with the
   Discord controller role — which the service checks on every request. This file
   hides the board from everyone else, it does not decide who may see it.
   ========================================================================== */
(function () {
    "use strict";

    var api = window.LATC;
    var root = document.querySelector("[data-radar]");

    if (!api || !root) {
        return;
    }

    var canvas = root.querySelector("[data-radar-canvas]");
    var lockedBox = root.querySelector("[data-radar-locked]");
    var errorBox = root.querySelector("[data-radar-error]");
    var updatedBox = root.querySelector("[data-radar-updated]");
    var signInLink = root.querySelector("[data-radar-signin]");

    if (signInLink && api.hasApi()) {
        signInLink.setAttribute("href", api.apiBase() + "/auth/discord");
    }

    function showLocked(message) {
        if (lockedBox) {
            lockedBox.hidden = false;
            var text = lockedBox.querySelector("[data-radar-locked-message]");
            if (text && message) {
                text.textContent = message;
            }
        }
        if (canvas) {
            canvas.hidden = true;
        }
    }

    function draw(radar) {
        var sectors = (radar && radar.sectors) || [];
        var positions = (radar && radar.positions) || [];

        if (canvas) {
            canvas.innerHTML = "";
            canvas.hidden = false;
        }
        if (lockedBox) {
            lockedBox.hidden = true;
        }

        sectors.forEach(function (sector) {
            var node = document.createElement("div");
            node.className = "radar-sector";

            /* Rows and columns come from the service, so the layout can be
               adjusted without touching this file. */
            node.style.gridColumn = String(sector.x);
            node.style.gridRow = String(sector.y);

            var heading = document.createElement("h3");
            heading.className = "radar-sector__name";
            heading.textContent = sector.name;
            node.appendChild(heading);

            if (sector.frequency) {
                var freq = document.createElement("p");
                freq.className = "radar-sector__freq";
                freq.textContent = sector.frequency;
                node.appendChild(freq);
            }

            var occupants = positions.filter(function (position) {
                return position.sector === sector.name;
            });

            var list = document.createElement("ul");
            list.className = "radar-sector__positions";

            if (occupants.length === 0) {
                var empty = document.createElement("li");
                empty.className = "radar-sector__position radar-sector__position--empty";
                empty.textContent = "Unstaffed";
                list.appendChild(empty);
            } else {
                occupants.forEach(function (position) {
                    var item = document.createElement("li");
                    item.className = "radar-sector__position";
                    item.textContent = position.callsign || "Controller";
                    if (position.role) {
                        var tag = document.createElement("span");
                        tag.className = "radar-sector__tag";
                        tag.textContent = position.role;
                        item.appendChild(tag);
                    }
                    list.appendChild(item);
                });
            }

            node.appendChild(list);
            canvas.appendChild(node);
        });

        if (updatedBox && radar && radar.updatedAt) {
            updatedBox.textContent = "Updated " + radar.updatedAt;
        }
    }

    api.apiRequest("/api/radar")
        .then(draw)
        .catch(function (error) {
            if (error.code === "unauthenticated") {
                showLocked("Sign in with Discord to view the Radar. Controllers are assigned their role in Discord, so the board knows who belongs on it.");
            } else if (error.code === "forbidden") {
                showLocked("The Radar is limited to active controllers. If you have just been promoted, sign in again to refresh your role.");
            } else if (error.code === "no_api") {
                showLocked("The Radar is not connected to a service yet.");
            } else {
                showLocked(error.message || "We could not load the Radar just now.");
            }
        });
})();
