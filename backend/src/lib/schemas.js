"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Loads and validates the application question sets from
 * Website/assets/data/applications.<role>.json.
 *
 * The same files drive the rendered form on the site and the checks on the
 * server, so adding a question is a one line edit here and the server picks it
 * up. Nothing about the questions is written twice.
 */

/* __dirname is backend/src/lib, so the repository root is three levels up. */
const DEFAULT_DATA_DIR = path.resolve(__dirname, "..", "..", "..", "Website", "assets", "data");

/**
 * Resolved per call rather than once at import, so a test can point the loader at
 * a fixture directory by setting LATC_DATA_DIR.
 */
function dataDir() {
    return process.env.LATC_DATA_DIR
        ? path.resolve(process.env.LATC_DATA_DIR)
        : DEFAULT_DATA_DIR;
}

const cache = new Map();

const TYPES = new Set(["text", "email", "number", "textarea", "select", "checkbox"]);

function loadSchema(role) {
    if (!/^(pilot|atc|staff)$/.test(String(role))) {
        throw new Error(`Unknown application role: ${role}`);
    }

    if (cache.has(role)) {
        return cache.get(role);
    }

    const file = path.join(dataDir(), `applications.${role}.json`);
    const raw = fs.readFileSync(file, "utf8");
    const schema = JSON.parse(raw);

    validateSchema(schema, role);
    cache.set(role, schema);
    return schema;
}

function validateSchema(schema, role) {
    const problems = [];

    if (!schema || typeof schema !== "object") {
        throw new Error(`applications.${role}.json must contain an object.`);
    }

    if (schema.role !== role) {
        problems.push(`role "${schema.role}" does not match the file name`);
    }

    if (!Array.isArray(schema.questions)) {
        throw new Error(`applications.${role}.json must have a questions array.`);
    }

    const seen = new Set();

    schema.questions.forEach((question, index) => {
        const where = `questions[${index}]`;

        if (!question || typeof question !== "object") {
            problems.push(`${where} must be an object`);
            return;
        }

        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(question.name || "")) {
            problems.push(`${where}.name must be a valid field name`);
        } else if (seen.has(question.name)) {
            problems.push(`${where}.name "${question.name}" is duplicated`);
        } else {
            seen.add(question.name);
        }

        if (!TYPES.has(question.type)) {
            problems.push(`${where}.type "${question.type}" is not one of ${[...TYPES].join(", ")}`);
        }

        if (typeof question.label !== "string" || !question.label.trim()) {
            problems.push(`${where}.label is required`);
        }

        if (question.type === "select") {
            if (!Array.isArray(question.options) || !question.options.length) {
                problems.push(`${where} is a select but has no options`);
            } else {
                question.options.forEach((option, optionIndex) => {
                    if (!option || !option.value || !option.label) {
                        problems.push(`${where}.options[${optionIndex}] needs a value and a label`);
                    }
                });
            }
        }
    });

    if (problems.length) {
        throw new Error(`applications.${role}.json is invalid:\n  - ${problems.join("\n  - ")}`);
    }
}

const LIMITS = {
    text: 200,
    email: 254,
    textarea: 2000,
    number: 3,
    select: 64,
    checkbox: 0
};

/**
 * Validates one submission against its schema.
 *
 * Returns { ok: true, values } or { ok: false, errors } where errors is keyed by
 * field name. Unknown fields are dropped rather than stored, which keeps a
 * tampered body from smuggling extra data into the database.
 */
function validateSubmission(schema, payload) {
    const errors = {};
    const values = {};

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, errors: { _form: "Expected a JSON object." } };
    }

    for (const question of schema.questions) {
        const raw = payload[question.name];

        if (question.type === "checkbox") {
            if (raw === true) {
                values[question.name] = true;
            } else if (question.required) {
                errors[question.name] = "You must confirm this to submit.";
            }
            continue;
        }

        const value = typeof raw === "string" ? raw.trim() : raw === undefined || raw === null ? "" : raw;

        if (value === "") {
            if (question.required) {
                errors[question.name] = "This field is required.";
            }
            continue;
        }

        if (question.type === "number") {
            const parsed = Number(value);

            if (!Number.isFinite(parsed)) {
                errors[question.name] = "Enter a number.";
            } else if (question.min !== undefined && parsed < question.min) {
                errors[question.name] = `Must be at least ${question.min}.`;
            } else if (question.max !== undefined && parsed > question.max) {
                errors[question.name] = `Must be at most ${question.max}.`;
            } else {
                values[question.name] = parsed;
            }
            continue;
        }

        const text = String(value);

        if (question.maxLength && text.length > question.maxLength) {
            errors[question.name] = `Keep this under ${question.maxLength} characters.`;
            continue;
        }

        if (question.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
            errors[question.name] = "Enter a valid email address.";
            continue;
        }

        if (question.type === "select") {
            const allowed = (question.options || []).map((option) => option.value);
            if (!allowed.includes(text)) {
                errors[question.name] = "Choose one of the listed options.";
                continue;
            }
        }

        values[question.name] = text;
    }

    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

/** Clears the module cache. Used by tests. */
function clearCache() {
    cache.clear();
}

module.exports = { loadSchema, validateSubmission, validateSchema, clearCache, dataDir, LIMITS };
