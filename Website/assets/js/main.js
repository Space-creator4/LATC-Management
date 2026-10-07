/* ==========================================================================
   Latitude ATC — main.js
   Page furniture shared by every page: the mobile nav, configuration-bound
   links, the statistics strip, scroll reveals, and the contact form.

   Feature behaviour lives in its own file and loads after this one:

     api.js           config access, the API client, session state
     theme.js         dark/light toggle
     auth.js          sign in / sign out, role-aware links
     forms.js         field validation helpers
     questions.js     builds application fields from the JSON question sets
     applications.js  eligibility gate, application submission
     queue.js         the Join page queue
     radar.js         the Radar board

   Pages only load the files they need, so a visitor reading the rules does not
   download the queue client.
   ========================================================================== */
(function () {
    "use strict";

    var config = window.LATC_CONFIG || {};

    /* Marks that scripting is available, so CSS can rely on it. Set first so
       styles that depend on it apply before the page is painted. */
    document.documentElement.classList.add("js");

    var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ------------------------------------------------------------------
       Header shadow
       ------------------------------------------------------------------ */
    var header = document.querySelector(".site-header");

    if (header) {
        var onScroll = function () {
            header.classList.toggle("is-scrolled", window.scrollY > 8);
        };

        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
    }

    /* ------------------------------------------------------------------
       Mobile navigation
       ------------------------------------------------------------------ */
    var navToggle = document.querySelector(".nav-toggle");
    var nav = document.getElementById("primary-nav");

    if (navToggle && nav) {
        var setNav = function (open) {
            navToggle.setAttribute("aria-expanded", String(open));
            nav.classList.toggle("is-open", open);
            document.body.classList.toggle("nav-open", open);
        };

        navToggle.addEventListener("click", function () {
            setNav(navToggle.getAttribute("aria-expanded") !== "true");
        });

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && nav.classList.contains("is-open")) {
                setNav(false);
                navToggle.focus();
            }
        });

        /* Closing on a link matters on a phone: otherwise the menu covers the
           page you just asked for. */
        nav.querySelectorAll("a").forEach(function (link) {
            link.addEventListener("click", function () {
                setNav(false);
            });
        });

        /* Matches the 1080px breakpoint where the nav collapses in main.css.
           Crossing it has to close the menu, or the open panel stays over the
           page after the layout has changed underneath it. */
        var desktop = window.matchMedia("(min-width: 1081px)");

        var onBreakpoint = function (event) {
            if (event.matches) {
                setNav(false);
            }
        };

        if (desktop.addEventListener) {
            desktop.addEventListener("change", onBreakpoint);
        } else if (desktop.addListener) {
            desktop.addListener(onBreakpoint);
        }

        setNav(false);
    }

    /* ------------------------------------------------------------------
       Configuration-bound links
       Anything pointing at an unset value is marked and left inert, so a
       half-finished config is visible rather than silently broken.
       ------------------------------------------------------------------ */
    var isPlaceholder = function (value) {
        return !value || /REPLACE|TODO|example\.com/i.test(value);
    };

    document.querySelectorAll("[data-config]").forEach(function (el) {
        var key = el.getAttribute("data-config");
        var value = config[key];

        if (!value) {
            return;
        }

        if (isPlaceholder(value)) {
            el.classList.add("is-unconfigured");
            el.setAttribute("aria-disabled", "true");
            el.removeAttribute("href");
            return;
        }

        el.setAttribute("href", value);

        if (el.hasAttribute("data-external")) {
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
        }
    });

    /* Belt and braces for anything still carrying the class without a handler,
       such as a button styled as a link. */
    document.addEventListener("click", function (event) {
        var link = event.target.closest && event.target.closest(".is-unconfigured");

        if (link) {
            event.preventDefault();
        }
    });

    /* ------------------------------------------------------------------
       Scroll reveals
       ------------------------------------------------------------------ */
    var revealables = document.querySelectorAll(".reveal");

    if (!prefersReducedMotion && "IntersectionObserver" in window) {
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) {
                    return;
                }
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            });
        }, { rootMargin: "0px 0px -8% 0px" });

        revealables.forEach(function (node) {
            observer.observe(node);
        });
    } else {
        /* Without animation support the content must simply be visible. */
        revealables.forEach(function (node) {
            node.classList.add("is-visible");
        });
    }

    /* ------------------------------------------------------------------
       Contact form
       Validated here, then confirmed locally. Nothing is sent anywhere.
       ------------------------------------------------------------------ */
    var contactForm = document.getElementById("contact-form");

    if (contactForm && window.LATCForms) {
        var contactAlert = document.getElementById("form-alert");

        contactForm.addEventListener("submit", function (event) {
            event.preventDefault();

            if (!window.LATCForms.validate(contactForm)) {
                return;
            }

            contactForm.hidden = true;

            if (contactAlert) {
                contactAlert.classList.add("is-visible");
                contactAlert.setAttribute("tabindex", "-1");
                contactAlert.focus();
            }
        });
    }
})();
