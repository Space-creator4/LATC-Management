/* ==========================================================================
   Latitude ATC — questions.js
   Builds application fields from assets/data/applications.<role>.json.

   The HTML ships only a container and a loading state; every field, label, and
   hint comes from the JSON. The service validates submissions against those same
   files, so adding a question means editing one file and nothing else.

   A form built this way cannot exist without JavaScript, which is why each one
   carries a <noscript> pointing at Discord instead of an empty box.
   ========================================================================== */
(function () {
    "use strict";

    /* This module lives at assets/js/questions.js and the schemas live at
       assets/data/. Resolving "assets/data/..." against the page would ask for
       /applications/pilot/assets/data/..., which does not exist, because the
       application forms sit one folder below the site root. Deriving the path
       from this script's own URL keeps the schemas reachable from any page
       depth, and whether the site is served from a domain root or a subfolder. */
    var scriptUrl = (document.currentScript && document.currentScript.src) || "";

    function dataUrl(setName) {
        if (!scriptUrl) {
            return "assets/data/" + setName + ".json";
        }

        /* Swap the file name for "../" to step out of assets/js/ and land in
           assets/, then re-enter it at data/. */
        return scriptUrl.replace(/[^/]*$/, "../") + "data/" + setName + ".json";
    }

    function buildControl(question, id) {
        var control;

        if (question.type === "textarea") {
            control = document.createElement("textarea");
            control.rows = question.rows || 4;
        } else if (question.type === "select") {
            control = document.createElement("select");

            var blank = document.createElement("option");
            blank.value = "";
            blank.textContent = "Choose an option";
            control.appendChild(blank);

            (question.options || []).forEach(function (option) {
                var node = document.createElement("option");
                node.value = option.value;
                node.textContent = option.label;
                control.appendChild(node);
            });
        } else {
            control = document.createElement("input");
            control.type = question.type === "number" ? "number" : question.type;

            if (question.type === "number") {
                control.inputMode = "numeric";
            }
        }

        control.className = "field__control";
        control.id = id;
        control.name = question.name;

        if (question.autocomplete) {
            control.setAttribute("autocomplete", question.autocomplete);
        }
        if (question.placeholder) {
            control.setAttribute("placeholder", question.placeholder);
        }
        if (question.maxLength) {
            control.maxLength = question.maxLength;
        }
        if (question.min !== undefined) {
            control.min = question.min;
        }
        if (question.max !== undefined) {
            control.max = question.max;
        }
        if (question.required) {
            control.required = true;
        }

        return control;
    }

    function buildField(question, prefix, rulesHref) {
        var id = prefix + "-" + question.name;
        var isCheck = question.type === "checkbox";
        var wrapper = document.createElement("div");

        wrapper.className = isCheck ? "field field--check" : "field";

        var label = document.createElement("label");
        label.className = "field__label";
        label.setAttribute("for", id);

        /* The rules checkbox gets a real link, because the visitor is being
           asked to agree to something and should be able to read it first. */
        if (isCheck && rulesHref) {
            label.appendChild(document.createTextNode("I have read the "));

            var link = document.createElement("a");
            link.setAttribute("href", rulesHref);
            link.textContent = "Latitude ATC rules";
            label.appendChild(link);

            label.appendChild(document.createTextNode(" and agree to follow them."));
        } else {
            label.appendChild(document.createTextNode(question.label));
        }

        if (question.required && !isCheck) {
            var star = document.createElement("span");
            star.className = "field__req";
            star.setAttribute("aria-hidden", "true");
            star.textContent = " *";
            label.appendChild(star);
        }

        var control = buildControl(question, id);

        /* Checkbox first, which is the order the flex row expects. */
        if (isCheck) {
            wrapper.appendChild(control);
            wrapper.appendChild(label);
        } else {
            wrapper.appendChild(label);
            wrapper.appendChild(control);
        }

        if (question.hint) {
            var hint = document.createElement("p");
            hint.className = "field__hint";
            hint.textContent = question.hint;
            wrapper.appendChild(hint);
        }

        var error = document.createElement("p");
        error.className = "field__error";
        error.setAttribute("data-error-for", id);
        error.setAttribute("role", "alert");
        wrapper.appendChild(error);

        return wrapper;
    }

    /* Short answers sit two to a row; long ones take the full width. Derived from
       the type, so adding a question never needs a layout decision. */
    function isShort(question) {
        return ["text", "email", "number"].indexOf(question.type) !== -1;
    }

    function render(form, schema, rulesHref) {
        var container = form.querySelector("[data-question-fields]");

        if (!container) {
            return;
        }

        var prefix = form.getAttribute("data-role") || "field";
        var row = null;

        schema.questions.forEach(function (question) {
            if (isShort(question)) {
                if (!row) {
                    row = document.createElement("div");
                    row.className = "form__row";
                    container.appendChild(row);
                }
                row.appendChild(buildField(question, prefix, rulesHref));
            } else {
                row = null;
                container.appendChild(buildField(question, prefix, rulesHref));
            }
        });

        var note = form.querySelector("[data-question-note]");

        if (note) {
            note.hidden = false;
        }

        form.removeAttribute("data-questions-loading");
        window.LATCForms.watchFields(form);
    }

    function renderFailure(form, reason) {
        var container = form.querySelector("[data-question-fields]");

        if (container) {
            container.innerHTML = "";

            var notice = document.createElement("div");
            notice.className = "closed-notice";

            var title = document.createElement("h4");
            title.className = "closed-notice__title";
            title.textContent = "The form could not be loaded";
            notice.appendChild(title);

            var text = document.createElement("p");
            text.textContent =
                reason === "file"
                    ? "This page has to be opened through a web server rather than straight from your computer, because the questions are loaded from a file."
                    : "The question list could not be read. Please apply in our Discord instead.";
            notice.appendChild(text);

            container.appendChild(notice);
        }

        /* Nothing was rendered, so there is nothing to submit. Leaving the
           button in place would let someone send an empty application, which
           the server would reject anyway, with a confusing error. */
        var submit = form.querySelector('[type="submit"]');

        if (submit) {
            submit.hidden = true;
        }

        form.removeAttribute("data-questions-loading");
    }

    document.querySelectorAll("[data-question-set]").forEach(function (form) {
        var setName = form.getAttribute("data-question-set");
        var rulesHref = form.getAttribute("data-rules-href");

        form.setAttribute("data-questions-loading", "true");

        if (!window.fetch || window.location.protocol === "file:") {
            renderFailure(form, window.location.protocol === "file:" ? "file" : "no-fetch");
            return;
        }

        fetch(dataUrl(setName), { headers: { Accept: "application/json" } })
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }
                return response.json();
            })
            .then(function (schema) {
                render(form, schema, rulesHref);
            })
            .catch(function () {
                renderFailure(form, "load-failed");
            });
    });
})();
