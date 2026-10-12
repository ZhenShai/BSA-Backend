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

const SOURCE_FIELDS = ["narrativeStudy", "biblicalParsing", "rhetoricalAnalysis"];

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

  // The first three methods are independent. All Findings operations need real sources.
  if (stage === "FINDINGS" && !SOURCE_FIELDS.some((field) => context[field])) {
    throw new ValidationError("Complete and select at least one study method before generating Biblical Study Findings.");
  }
  if (stage === "FINAL_RESULT" && !context.biblicalStudyFindings) {
    throw new ValidationError("Complete Biblical Study Findings before preparing a Final Study Result.");
  }
  // Older clients have no workflow envelope. New clients must supply both Step 5 conditions.
  if (raw.workflow !== undefined) {
    if (!raw.workflow || typeof raw.workflow !== "object" || Array.isArray(raw.workflow) || raw.workflow.version !== 2) {
      throw new ValidationError("Invalid study workflow information.");
    }
    if (stage === "FINAL_RESULT" && (raw.workflow.step5Enabled !== true || raw.workflow.findingsCurrent !== true)) {
      throw new ValidationError("Enable Final Study Result and update Biblical Study Findings first.");
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
