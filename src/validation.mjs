export const STAGES = new Set([
  "NARRATIVE",
  "PARSING",
  "RHETORICAL",
  "FINDINGS",
  "FINAL_RESULT",
]);

export const OPERATIONS = new Set([
  "generate",
  "verify",
  "chat",
  "regenerate",
  "closing_prayer",
]);

const PROJECT_FIELDS = [
  "title",
  "bibleBook",
  "chapter",
  "startVerse",
  "endVerse",
  "primaryReference",
  "extendedReference",
  "bibleTranslation",
  "passageText",
  "occasion",
  "audience",
  "personalStudyNotes",
  "language",
  "studyDepth",
];

const CONTEXT_FIELDS = [
  "narrativeStudy",
  "narrativeNotes",
  "biblicalParsing",
  "parsingNotes",
  "rhetoricalAnalysis",
  "rhetoricalNotes",
  "biblicalStudyFindings",
  "myStudyConclusion",
  "finalStudyResult",
  "currentStageOutput",
  "currentStageNotes",
];

// These fields can contain long Bible-study content.
// This prevents Biblical Parsing, Rhetorical Analysis,
// Findings, and Final Study Result from being limited
// to only 1,000 characters.
const LONG_TEXT_FIELDS = new Set([
  "passageText",
  "personalStudyNotes",
  "narrativeStudy",
  "narrativeNotes",
  "biblicalParsing",
  "parsingNotes",
  "rhetoricalAnalysis",
  "rhetoricalNotes",
  "biblicalStudyFindings",
  "myStudyConclusion",
  "finalStudyResult",
  "currentStageOutput",
  "currentStageNotes",
]);

const GENERATION_REQUIREMENTS = {
  NARRATIVE: [],

  PARSING: [
    "narrativeStudy",
  ],

  RHETORICAL: [
    "narrativeStudy",
    "biblicalParsing",
  ],

  FINDINGS: [
    "narrativeStudy",
    "biblicalParsing",
    "rhetoricalAnalysis",
  ],

  FINAL_RESULT: [
    "narrativeStudy",
    "biblicalParsing",
    "rhetoricalAnalysis",
    "biblicalStudyFindings",
  ],
};

export function validateStudyRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(
      "The request body must be a JSON object.",
    );
  }

  const operation = cleanEnum(
    raw.operation,
    OPERATIONS,
    "operation",
  );

  const stage = cleanEnum(
    raw.stage,
    STAGES,
    "stage",
  );

  if (
    operation === "closing_prayer" &&
    stage !== "FINAL_RESULT"
  ) {
    throw new ValidationError(
      "A closing prayer may only be created for the Final Study Result.",
    );
  }

  const project = cleanObject(
    raw.project,
    PROJECT_FIELDS,
    360_000,
    "project",
  );

  if (
    !project.primaryReference ||
    !project.bibleBook ||
    !project.chapter
  ) {
    throw new ValidationError(
      "Bible book, chapter, and primary reference are required.",
    );
  }

  const context = cleanObject(
    raw.context,
    CONTEXT_FIELDS,
    1_500_000,
    "context",
  );

  const userPrompt = cleanText(
    raw.userPrompt,
    12_000,
    "userPrompt",
  );

  const regenerationMode = cleanText(
    raw.regenerationMode,
    120,
    "regenerationMode",
  );

  if (
    operation === "chat" &&
    !userPrompt
  ) {
    throw new ValidationError(
      "A follow-up question is required.",
    );
  }

  if (
    operation === "regenerate" &&
    !regenerationMode
  ) {
    throw new ValidationError(
      "A controlled regeneration mode is required.",
    );
  }

  if (
    [
      "verify",
      "chat",
      "regenerate",
      "closing_prayer",
    ].includes(operation) &&
    !context.currentStageOutput
  ) {
    throw new ValidationError(
      "The current study stage must have a saved result for this operation.",
    );
  }

  if (operation === "generate") {
    const missing =
      GENERATION_REQUIREMENTS[stage].filter(
        (field) => !context[field],
      );

    if (missing.length) {
      throw new ValidationError(
        "Complete the preceding study stages before generating this stage.",
      );
    }
  }

  return {
    operation,
    stage,
    project,
    context,
    userPrompt,
    regenerationMode,
    includeSources:
      raw.includeSources === true,
    includeClosingPrayer:
      raw.includeClosingPrayer === true,
  };
}

function cleanEnum(
  value,
  allowed,
  field,
) {
  if (
    typeof value !== "string" ||
    !allowed.has(value)
  ) {
    throw new ValidationError(
      `Invalid ${field}.`,
    );
  }

  return value;
}

function cleanObject(
  value,
  allowedFields,
  totalLimit,
  field,
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new ValidationError(
      `${field} must be an object.`,
    );
  }

  const output = {};
  let total = 0;

  for (const key of allowedFields) {
    const max =
      LONG_TEXT_FIELDS.has(key)
        ? 180_000
        : 1_000;

    output[key] = cleanText(
      value[key],
      max,
      `${field}.${key}`,
    );

    total += output[key].length;
  }

  if (total > totalLimit) {
    throw new ValidationError(
      `${field} is too large.`,
    );
  }

  return output;
}

function cleanText(
  value,
  maxLength,
  field,
) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  if (typeof value !== "string") {
    throw new ValidationError(
      `${field} must be text.`,
    );
  }

  const cleaned = value
    .replaceAll("\u0000", "")
    .trim();

  if (cleaned.length > maxLength) {
    throw new ValidationError(
      `${field} is too long.`,
    );
  }

  return cleaned;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}
