/* ==========================================================================
   Latitude ATC — applications.js
   The eligibility gate, application submission, and the contact form.

   Two rules matter here.

   First, the gate on the ATC page is presentation. It saves a wasted submission,
   but it cannot be trusted: anyone can post JSON by hand, so the service checks
   the applicant's Discord roles itself before accepting anything.

   Second, applications can only be sent by someone signed in with Discord. The
   button says so, and the service rejects anonymous submissions with 401 either
   way. The server is the control, not this file.
   ========================================================================== */
(function () {
    "use strict";

    var api = window.LATC;
    var forms = window.LATCForms;

    /* ------------------------------------------------------------------
       Status messages
       ------------------------------------------------------------------ */
    function showStatus(box, state, title, message) {
        if (!box) {
            return;
        }

        box.className = "form-alert form-alert--" + state;
        box.innerHTML =
            '<svg class="form-alert__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2" aria-hidden="true">' +
            (state === "success"
                ? '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9"/>'
                : '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>') +
            "</svg>" +
            "<div><strong></strong><p></p></div>";

        box.querySelector("strong").textContent = title;
        box.querySelector("p").textContent = message;
        box.classList.add("is-visible");
        box.setAttribute("tabindex", "-1");
        box.focus();
    }

    function panelScope(form) {
        return form.closest(".apply-panel__body") || form.parentElement;
    }

    function statusBoxFor(form) {
        var scope = panelScope(form);
        return scope ? scope.querySelector("[data-form-status]") : null;
    }

    /* ------------------------------------------------------------------
       Eligibility gate
       ------------------------------------------------------------------ */
    document.querySelectorAll("[data-requires-eligibility]").forEach(function (form) {
        var gate = document.querySelector("[data-eligibility]");
        var result = document.querySelector("[data-eligibility-result]");

        if (!gate || !result) {
            return;
        }

        var gateError = gate.querySelector(".field__error");

        gate.querySelectorAll("[data-eligibility-answer]").forEach(function (input) {
            input.addEventListener("change", function () {
                var eligible = input.value === "yes" && input.checked;

                form.hidden = !eligible;
                result.hidden = eligible;

                /* The question stays visible either way, so the blocked message
                   has the question it answers sitting directly above it. */
                gate.hidden = false;

                if (gateError) {
                    gateError.classList.remove("is-visible");
                    gateError.textContent = "";
                }

                if (eligible) {
                    var first = form.querySelector("input:not([type=hidden]), textarea, select");
                    if (first) {
                        first.focus();
                    }
                }
            });
        });
    });

    /* ------------------------------------------------------------------
       Application submission
       ------------------------------------------------------------------ */
    document.querySelectorAll("[data-application-form]").forEach(function (form) {
        var role = form.getAttribute("data-role") || "unknown";
        var submitButton = form.querySelector('[type="submit"]');
        var scope = panelScope(form);
        var box = statusBoxFor(form);
        /* The prompt and the summary are siblings of the form inside the panel,
           not children of it, so they have to be looked up in the panel. */
        var signInPrompt = scope ? scope.querySelector("[data-signin-prompt]") : null;
        var summary = scope ? scope.querySelector("[data-application-summary]") : null;

        var submitLabel = (submitButton && submitButton.textContent.trim()) || "Submit";

        function setBusy(busy) {
            if (!submitButton) {
                return;
            }
            submitButton.disabled = busy;
            submitButton.textContent = busy ? "Sending…" : submitLabel;
        }

        function describeFailure(error) {
            if (error.code === "unauthenticated") {
                return [
                    "Sign in with Discord first",
                    "Applications are tied to your Discord account, so your roles can be checked. Use the sign in button above, then submit again."
                ];
            }
            if (error.code === "forbidden") {
                return [
                    "You cannot apply for this position",
                    error.message || "Applying as a controller needs an approved pilot application. If that is wrong, ask a member of staff on Discord."
                ];
            }
            if (error.code === "closed") {
                return ["Applications are closed", error.message || "This position is not accepting applications right now."];
            }
            if (error.code === "validation" && error.errors) {
                var firstKey = Object.keys(error.errors)[0];

                if (firstKey) {
                    forms.setError(form, form.elements[firstKey] || form, error.errors[firstKey]);
                }
                return ["Check the form", "One or more answers need attention. The first problem is marked below."];
            }
            if (error.code === "no_api") {
                return [
                    "Applications are not connected yet",
                    "This site is not pointed at a working service. Please apply in our Discord in the meantime."
                ];
            }
            if (error.code === "network" || error.code === null) {
                return [
                    "We could not reach the service",
                    "Check your connection and try again. If it keeps failing, please apply in our Discord."
                ];
            }
            return ["Something went wrong", error.message || "Please try again, or apply in our Discord."];
        }

        function collect() {
            var payload = {
                role: role,
                source: "latc-website",
                submittedAt: new Date().toISOString()
            };

            form.querySelectorAll("[name]").forEach(function (field) {
                payload[field.name] = field.type === "checkbox" ? field.checked : field.value.trim();
            });

            return payload;
        }

        form.addEventListener("submit", function (event) {
            event.preventDefault();

            if (box) {
                box.classList.remove("is-visible");
            }

            /* Applications belong to a Discord account, so there is no point
               sending one the server will only reject. Say so plainly, and leave
               the answers in place: the visitor can sign in without losing them. */
            if (!api.isSignedIn()) {
                if (signInPrompt) {
                    signInPrompt.hidden = false;
                }
                showStatus(
                    box,
                    "error",
                    "Sign in to apply",
                    "Applications are tied to your Discord account. Sign in using the button above and submit again, your answers will still be here."
                );
                return;
            }

            if (!forms.validate(form)) {
                showStatus(box, "error", "Check the form", "Some answers are missing. The first one is marked below.");
                return;
            }

            setBusy(true);

            api.apiRequest("/api/applications", { method: "POST", body: collect() })
                .then(function (result) {
                    form.hidden = true;

                    if (signInPrompt) {
                        signInPrompt.hidden = true;
                    }
                    if (summary) {
                        summary.hidden = false;
                    }

                    showStatus(
                        box,
                        "success",
                        "Application received",
                        result && result.message
                            ? result.message
                            : "Thank you. A member of staff will review it and get back to you on Discord."
                    );
                })
                .catch(function (error) {
                    var described = describeFailure(error);
                    showStatus(box, "error", described[0], described[1]);
                })
                .then(function () {
                    setBusy(false);
                });
        });

        /* Reflect session state so the button can explain itself before the
           visitor tries. After submitting, the summary takes over and the form
           stays out of the way. */
        api.onSessionChange(function (session) {
            if (form.hidden) {
                return;
            }

            if (signInPrompt) {
                signInPrompt.hidden = api.isSignedIn();
            }
        });
    });
})();
