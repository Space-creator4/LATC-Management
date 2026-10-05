"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSchema, validateSubmission, validateSchema, clearCache } = require("../src/lib/schemas");

const goodPilot = {
    robloxUsername: "Aviator",
    discordUsername: "aviator#1",
    email: "aviator@example.com",
    age: "18",
    experience: "Some flight sim time",
    availability: "evenings",
    motivation: "I want to help new pilots",
    agreedRules: true
};

test("question sets load and validate", () => {
    clearCache();

    for (const role of ["pilot", "atc", "staff"]) {
        const schema = loadSchema(role);
        assert.equal(schema.role, role);
        assert.ok(Array.isArray(schema.questions));
    }
});

test("atc question set declares the pilot requirement", () => {
    const schema = loadSchema("atc");
    assert.equal(schema.requiresPilot, true);
    assert.ok(schema.questions.some((q) => q.name === "pilotReference"));
});

test("staff question set is marked closed", () => {
    const schema = loadSchema("staff");
    assert.equal(schema.closed, true);
    assert.deepEqual(schema.questions, []);
});

test("a valid pilot submission passes", () => {
    const result = validateSubmission(loadSchema("pilot"), goodPilot);
    assert.equal(result.ok, true);
    assert.equal(result.values.age, 18, "age should be coerced to a number");
    assert.equal(result.values.agreedRules, true);
});

test("missing required fields are reported by name", () => {
    const result = validateSubmission(loadSchema("pilot"), {});
    assert.equal(result.ok, false);
    assert.ok(result.errors.robloxUsername);
    assert.ok(result.errors.agreedRules);
});

test("select values outside the list are rejected", () => {
    const result = validateSubmission(loadSchema("pilot"), {
        ...goodPilot,
        availability: "whenever"
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.availability, /listed options/);
});

test("age outside the minimum is rejected", () => {
    const result = validateSubmission(loadSchema("pilot"), { ...goodPilot, age: "5" });
    assert.equal(result.ok, false);
    assert.match(result.errors.age, /at least 13/);
});

test("a malformed address is rejected when the schema collects an email", () => {
    /* The pilot and ATC schemas do not collect an email, because the applicant's
       Discord account is their identity. The validator still has an email branch
       for any future question set that needs one, so it is covered here against
       a schema declared inline rather than against a shipped file. */
    const schema = {
        role: "pilot",
        questions: [{ name: "email", label: "Email", type: "email", required: true }]
    };

    const bad = validateSubmission(schema, { email: "not-an-email" });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.email, /valid email/);

    const good = validateSubmission(schema, { email: "aviator@example.com" });
    assert.equal(good.ok, true);
    assert.equal(good.values.email, "aviator@example.com");
});

test("over-long text is rejected", () => {
    const result = validateSubmission(loadSchema("pilot"), {
        ...goodPilot,
        motivation: "x".repeat(2001)
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.motivation, /under 2000/);
});

test("unknown fields are dropped rather than stored", () => {
    const result = validateSubmission(loadSchema("pilot"), {
        ...goodPilot,
        isStaff: true,
        discord_user_id: "999"
    });
    assert.equal(result.ok, true);
    assert.equal(result.values.isStaff, undefined);
    assert.equal(result.values.discord_user_id, undefined);
});

test("a non-object body is refused", () => {
    const result = validateSubmission(loadSchema("pilot"), "nope");
    assert.equal(result.ok, false);
    assert.ok(result.errors._form);
});

test("a schema with a duplicate field name is rejected", () => {
    assert.throws(
        () =>
            validateSchema(
                {
                    role: "pilot",
                    questions: [
                        { name: "email", label: "A", type: "text" },
                        { name: "email", label: "B", type: "text" }
                    ]
                },
                "pilot"
            ),
        /duplicated/
    );
});

test("a select with no options is rejected", () => {
    assert.throws(
        () =>
            validateSchema(
                { role: "pilot", questions: [{ name: "pick", label: "Pick", type: "select" }] },
                "pilot"
            ),
        /no options/
    );
});

test("an unsupported field type is rejected", () => {
    assert.throws(
        () =>
            validateSchema(
                { role: "pilot", questions: [{ name: "x", label: "X", type: "file" }] },
                "pilot"
            ),
        /not one of/
    );
});
