import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

// Simple check to know that the backend is running
app.get("/", (req, res) => {
  res.json({
    success: true,
    app: "BSA Backend",
    message: "Biblical Study Assistant secure server is running."
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "ok"
  });
});

// Optional protection for the Android application
function checkAppToken(req, res, next) {
  const requiredToken = process.env.APP_ACCESS_TOKEN;

  // If no APP_ACCESS_TOKEN is configured in Render,
  // token protection is disabled.
  if (!requiredToken) {
    return next();
  }

  const headerToken = req.headers["x-app-token"];

  const authorization = req.headers.authorization;
  const bearerToken =
    authorization && authorization.startsWith("Bearer ")
      ? authorization.substring(7)
      : null;

  const suppliedToken = headerToken || bearerToken;

  if (suppliedToken !== requiredToken) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized application."
    });
  }

  next();
}

// Main Biblical Study Assistant endpoint
app.post("/api/study", checkAppToken, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "OPENAI_API_KEY is not configured on the server."
      });
    }

    const body = req.body || {};

    // Accept several common request field names
    const userInput =
      body.prompt ??
      body.input ??
      body.message ??
      body.query;

    if (!userInput) {
      return res.status(400).json({
        success: false,
        error: "No study prompt was provided."
      });
    }

    const instructions =
      body.instructions ||
      `You are the secure AI study engine for BSA — Biblical Study Assistant.

Provide careful, biblically responsible study assistance.

Follow the study instructions sent by the application.
Preserve the biblical passage, context, observations, and previous study findings supplied by the user.
Do not invent biblical facts, Hebrew or Greek forms, historical details, or citations.
Clearly distinguish biblical text, observation, interpretation, and application.
Use the requested language, audience, and study format when supplied.`;

    const model =
      process.env.OPENAI_MODEL || "gpt-5.6";

    const openAIResponse = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          instructions,
          input: userInput
        })
      }
    );

    const data = await openAIResponse.json();

    if (!openAIResponse.ok) {
      console.error("OpenAI API error:", data);

      return res.status(openAIResponse.status).json({
        success: false,
        error:
          data?.error?.message ||
          "The OpenAI API request failed."
      });
    }

    // Extract the generated text from the Responses API
    let generatedText = "";

    if (Array.isArray(data.output)) {
      for (const outputItem of data.output) {
        if (outputItem.type === "message" && Array.isArray(outputItem.content)) {
          for (const contentItem of outputItem.content) {
            if (
              contentItem.type === "output_text" &&
              typeof contentItem.text === "string"
            ) {
              generatedText += contentItem.text;
            }
          }
        }
      }
    }

    return res.json({
      success: true,
      text: generatedText,
      output_text: generatedText,
      responseId: data.id || null
    });
  } catch (error) {
    console.error("BSA Backend Error:", error);

    return res.status(500).json({
      success: false,
      error: "An unexpected server error occurred."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BSA Backend running on port ${PORT}`);
});
