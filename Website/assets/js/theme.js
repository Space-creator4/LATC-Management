/* ==========================================================================
   Latitude ATC — theme.js
   Dark by default, with a toggle that is remembered.

   The initial theme is applied by a tiny inline script in each page head, before
   first paint, so a returning visitor never sees a flash of the wrong theme. This
   file wires up the buttons themselves.
   ========================================================================== */
(function () {
    "use strict";

    var STORAGE_KEY = "latc-theme";

    function current() {
        return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    }

    function paint() {
        document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
            var light = current() === "light";

            button.setAttribute("aria-pressed", String(light));

            var label = button.querySelector("[data-theme-label]");

            if (label) {
                label.textContent = light ? "Dark theme" : "Light theme";
            }
        });
    }

    paint();

    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
        button.addEventListener("click", function () {
            var next = current() === "light" ? "dark" : "light";

            if (next === "light") {
                document.documentElement.setAttribute("data-theme", "light");
            } else {
                document.documentElement.removeAttribute("data-theme");
            }

            paint();

            try {
                window.localStorage.setItem(STORAGE_KEY, next);
            } catch (error) {
                /* Private browsing can refuse writes. The toggle still works for
                   this page view, it just will not be remembered. */
            }
        });
    });
})();
