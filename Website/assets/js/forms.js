/* ==========================================================================
   Latitude ATC — forms.js
   Validation, plus building application fields from the JSON question sets.

   Application questions live in assets/data/applications.<role>.json rather than
   in the HTML. The page builds its fields from that file and the server validates
   against the same copy, so a question can never exist on one side only. Adding a
   question means editing one JSON file.

   Consequence worth knowing: a form built from JSON cannot exist without
   JavaScript, so each one carries a <noscript> pointing at Discord rather than an
   empty box. Everything else on the site still works without JS.
   ========================================================================== */
(function () {
    "use strict";

    /* ------------------------------------------------------------------
       Validation
       ------------------------------------------------------------------ */
    function setError(form, field, message) {
        var error = form.querySelector('[data-error-for="' + field.id + '"]');

        if (error) {
            error.textContent = message;
            error.classList.add("is-visible");
        }
        field.setAttribute("aria-invalid", "true");
    }

    function clearError(form, field) {
        var error = form.querySelector('[data-error-for="' + field.id + '"]');

        if (error) {
            error.classList.remove("is-visible");
        }
        field.removeAttribute("aria-invalid");
    }

    /* A checkbox is satisfied by being checked, not by having text. */
    function isSatisfied(field) {
        if (field.type === "checkbox") {
            return field.checked;
        }
        return field.value.trim() !== "" && field.checkValidity();
    }

    function messageFor(field) {
        if (field.type === "checkbox") {
            return "You must confirm this to submit.";
        }
        if (field.type === "email" && field.value.trim() !== "") {
            return "Enter a valid email address.";
        }
        if (field.type === "number" && field.min !== "") {
            var value = Number(field.value);
            if (Number.isFinite(value) && value < Number(field.min)) {
                return "Must be at least " + field.min + ".";
            }
        }
        return "This field is required.";
    }

    function validate(form) {
        var fields = form.querySelectorAll("[required]");
        var firstInvalid = null;

        fields.forEach(function (field) {
            if (isSatisfied(field)) {
                clearError(form, field);
                return;
            }
            setError(form, field, messageFor(field));
            if (!firstInvalid) {
                firstInvalid = field;
            }
        });

        if (firstInvalid) {
            firstInvalid.focus();
        }
        return !firstInvalid;
    }

    function watchFields(form) {
        form.querySelectorAll("input, textarea, select").forEach(function (field) {
            var recheck = function () {
                if (field.getAttribute("aria-invalid") === "true" && isSatisfied(field)) {
                    clearError(form, field);
                }
            };

            field.addEventListener("input", recheck);
            field.addEventListener("change", recheck);
        });
    }

    document.querySelectorAll("form").forEach(watchFields);

    window.LATCForms = { validate: validate, setError: setError, watchFields: watchFields };
})();
