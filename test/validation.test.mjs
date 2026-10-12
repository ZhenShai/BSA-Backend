import test from "node:test";
import assert from "node:assert/strict";
import { buildInstructions } from "../src/prompts.mjs";
import { validateStudyRequest, ValidationError } from "../src/validation.mjs";

function validBody() {
  return {
    operation: "generate",
    stage: "NARRATIVE",
    project: {
      title: "Naaman",
      bibleBook: "2 Kings",
      chapter: "5",
      startVerse: "1",
      endVerse: "14",
      primaryReference: "2 Kings 5:1-14",
      passageText: "",
      audience: "Sunday Worship",
      language: "English",
      studyDepth: "Pastoral",
    },
    context: {},
    includeSources: false,
  };
}

test("accepts and normalizes a valid narrative request", () => {
  const request = validateStudyRequest(validBody());
  assert.equal(request.stage, "NARRATIVE");
  assert.equal(request.project.primaryReference, "2 Kings 5:1-14");
});

test("rejects an unknown stage", () => {
  const body = validBody();
  body.stage = "INSTANT_SERMON";
  assert.throws(() => validateStudyRequest(body), ValidationError);
});

test("requires a question for stage chat", () => {
  const body = validBody();
  body.operation = "chat";
  body.context.currentStageOutput = "A saved narrative study.";
  assert.throws(() => validateStudyRequest(body), /follow-up question/i);
});

test("closing prayer is restricted to Final Study Result", () => {
  const body = validBody();
  body.operation = "closing_prayer";
  assert.throws(() => validateStudyRequest(body), /Final Study Result/i);
});

test("final profile requires main points and forbids movement labels", () => {
  const body = validBody();
  body.stage = "FINAL_RESULT";
  body.context = {
    narrativeStudy: "Narrative findings",
    biblicalParsing: "Parsing findings",
    rhetoricalAnalysis: "Rhetorical findings",
    biblicalStudyFindings: "Synthesis",
  };
  const request = validateStudyRequest(body);
  const instructions = buildInstructions(request);
  assert.match(instructions, /MAIN POINTS/);
  assert.match(instructions, /Never label them Movement 1/);
  assert.match(instructions, /complete, full-length, preach-ready/i);
});

test("accepts a single completed method for Findings", () => {
  const body = validBody();
  body.stage = "FINDINGS";
  body.context = { narrativeStudy: "Narrative findings" };
  assert.equal(validateStudyRequest(body).stage, "FINDINGS");
});

test("verification requires a saved current result", () => {
  const body = validBody();
  body.operation = "verify";
  assert.throws(() => validateStudyRequest(body), /saved result/i);
});

const methods = ["NARRATIVE", "PARSING", "RHETORICAL"];
const fields = ["narrativeStudy", "biblicalParsing", "rhetoricalAnalysis"];
for (const stage of methods) {
  test(`${stage} can start independently`, () => {
    assert.equal(validateStudyRequest({ ...validBody(), stage }).stage, stage);
  });
}
for (let mask = 1; mask < 8; mask++) {
  test(`Findings accepts exactly selected subset ${mask}`, () => {
    const context = Object.fromEntries(fields.filter((_, i) => mask & (1 << i)).map((f) => [f, `${f} completed`]));
    const request = validateStudyRequest({ ...validBody(), stage: "FINDINGS", context });
    const instructions = buildInstructions(request);
    assert.match(instructions, /ONLY the completed, selected/);
    for (let i = 0; i < fields.length; i++) assert.equal(Boolean(request.context[fields[i]]), Boolean(mask & (1 << i)));
  });
}
test("Findings rejects an empty subset, including regeneration", () => {
  for (const operation of ["generate", "regenerate"]) assert.throws(() => validateStudyRequest({
    ...validBody(), stage: "FINDINGS", operation, regenerationMode: "clarify",
    context: { currentStageOutput: "Old findings" },
  }), /at least one study method/);
});
test("all three methods cannot bypass Findings for Final Result", () => {
  for (const operation of ["generate", "regenerate", "verify", "chat", "closing_prayer"]) {
    assert.throws(() => validateStudyRequest({ ...validBody(), stage: "FINAL_RESULT", operation,
      userPrompt: "Explain", regenerationMode: "clarify", context: {
        narrativeStudy: "N", biblicalParsing: "P", rhetoricalAnalysis: "R", currentStageOutput: "Old final",
      } }), /Complete Biblical Study Findings/);
  }
});
test("Final Result needs both workflow conditions, with Findings only sufficient", () => {
  for (const step5Enabled of [false, true]) for (const findingsCurrent of [false, true]) {
    const body = { ...validBody(), stage: "FINAL_RESULT", context: { biblicalStudyFindings: "Meaning" },
      workflow: { version: 2, step5Enabled, findingsCurrent } };
    if (step5Enabled && findingsCurrent) assert.equal(validateStudyRequest(body).stage, "FINAL_RESULT");
    else assert.throws(() => validateStudyRequest(body), /Enable Final Study Result/);
  }
});
test("long Parsing and Rhetorical findings are preserved", () => {
  const body = { ...validBody(), stage: "FINDINGS", context: { biblicalParsing: "P".repeat(5000), rhetoricalAnalysis: "R".repeat(5000) } };
  assert.equal(validateStudyRequest(body).context.biblicalParsing.length, 5000);
});
