// src/lib/gemini.ts

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const GEMINI_API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

interface GeminiCallOptions {
  systemInstruction?: string;
  temperature?: number;
  jsonSchema?: object;
}

/**
 * Call Gemini API
 */
export async function callGemini(
  prompt: string,
  options: GeminiCallOptions = {}
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  console.log("🤖 Calling Gemini model:", GEMINI_MODEL);

  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],

    generationConfig: {
      temperature: options.temperature ?? 0.4,
      maxOutputTokens: 4096,

      ...(options.jsonSchema
        ? {
            responseMimeType: "application/json",
            responseSchema: options.jsonSchema,
          }
        : {}),
    },
  };

  if (options.systemInstruction) {
    body.systemInstruction = {
      parts: [
        {
          text: options.systemInstruction,
        },
      ],
    };
  }

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify(body),

    cache: "no-store",
  });

  const responseText = await res.text();

  console.log("📡 Gemini status:", res.status);

  if (!res.ok) {
    console.error("❌ Gemini API Error:", responseText);

    throw new Error(
      `Gemini API error (${res.status}): ${responseText}`
    );
  }

  let data: any;

  try {
    data = JSON.parse(responseText);
  } catch {
    console.error("❌ Invalid Gemini API response:", responseText);

    throw new Error("Gemini returned an invalid response.");
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part: any) => part.text || "")
      .join("")
      .trim();

  if (!text) {
    console.error(
      "❌ Gemini empty response:",
      JSON.stringify(data, null, 2)
    );

    throw new Error("Gemini API returned an empty response.");
  }

  console.log("✅ Gemini response received");

  return text;
}

/**
 * Extract JSON safely from Gemini response
 */
function extractJSON(raw: string): string {
  let cleaned = raw.trim();

  // Remove markdown code fences
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  // Find JSON object
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  return cleaned;
}

/**
 * Call Gemini and parse JSON response safely
 */
export async function callGeminiJSON<T = unknown>(
  prompt: string,
  options: GeminiCallOptions = {}
): Promise<T> {
  const raw = await callGemini(prompt, options);

  console.log("📄 Raw Gemini response:", raw);

  const cleaned = extractJSON(raw);

  try {
    return JSON.parse(cleaned) as T;
  } catch (error) {
    console.error("❌ JSON Parse Failed");
    console.error("Raw:", raw);
    console.error("Cleaned:", cleaned);

    throw new Error(
      `Failed to parse Gemini JSON response: ${cleaned.slice(0, 500)}`
    );
  }
}

// ======================================================
// Resume Analysis
// ======================================================

export interface ResumeAnalysis {
  matchScore: number;
  summary: string;
  strengths: string[];
  gaps: string[];
  recommendation:
    | "STRONG_MATCH"
    | "GOOD_MATCH"
    | "PARTIAL_MATCH"
    | "WEAK_MATCH";
}

export async function analyzeResume(params: {
  jobTitle: string;
  jobDescription: string;
  jobRequirements?: string | null;
  jobSkills?: string | null;
  resumeText: string;
}): Promise<ResumeAnalysis> {
  console.log("📄 Starting Resume Analysis...");
  console.log("Job:", params.jobTitle);
  console.log("Resume length:", params.resumeText.length);

  const prompt = `
You are an expert AI recruiter and resume screening system.

Your task is to analyze the candidate's resume against the job requirements.

JOB TITLE:
${params.jobTitle}

JOB DESCRIPTION:
${params.jobDescription || "Not provided"}

JOB REQUIREMENTS:
${params.jobRequirements || "Not provided"}

REQUIRED SKILLS:
${params.jobSkills || "Not provided"}

CANDIDATE RESUME:
${params.resumeText}

Evaluate the candidate carefully.

Calculate a realistic match score between 0 and 100.

Return ONLY valid JSON.

The JSON MUST follow exactly this structure:

{
  "matchScore": 75,
  "summary": "Brief professional summary of the candidate's suitability.",
  "strengths": [
    "Relevant technical experience",
    "Strong communication skills"
  ],
  "gaps": [
    "Limited experience with cloud infrastructure"
  ],
  "recommendation": "GOOD_MATCH"
}

IMPORTANT RULES:

- matchScore must be an integer from 0 to 100.
- strengths must always be an array.
- gaps must always be an array.
- recommendation must be exactly one of:
  STRONG_MATCH
  GOOD_MATCH
  PARTIAL_MATCH
  WEAK_MATCH
- Do not use markdown.
- Do not use code fences.
- Do not include explanations outside JSON.
`.trim();

  const analysis = await callGeminiJSON<ResumeAnalysis>(
    prompt,
    {
      temperature: 0.2,
    }
  );

  // Validate result
  if (
    typeof analysis.matchScore !== "number" ||
    Number.isNaN(analysis.matchScore)
  ) {
    throw new Error("Gemini returned invalid matchScore.");
  }

  analysis.matchScore = Math.max(
    0,
    Math.min(100, Math.round(analysis.matchScore))
  );

  if (!Array.isArray(analysis.strengths)) {
    analysis.strengths = [];
  }

  if (!Array.isArray(analysis.gaps)) {
    analysis.gaps = [];
  }

  console.log(
    `✅ Resume analysis completed. Match score: ${analysis.matchScore}%`
  );

  return analysis;
}

// ======================================================
// Job Post Generation
// ======================================================

export interface GeneratedJobPost {
  description: string;
  requirements: string;
  responsibilities: string;
  skills: string;
  employmentType: string;
  experienceLevel: string;
  salaryRange: string;
}

export async function generateJobPost(params: {
  title: string;
  department?: string;
  location?: string;
}): Promise<GeneratedJobPost> {
  const prompt = `Write a complete, professional job posting.

JOB TITLE: ${params.title}
DEPARTMENT: ${params.department || "N/A"}
LOCATION: ${params.location || "N/A"}

Return ONLY valid JSON:

{
  "description": "",
  "requirements": "",
  "responsibilities": "",
  "skills": "",
  "employmentType": "",
  "experienceLevel": "",
  "salaryRange": ""
}`;

  return callGeminiJSON<GeneratedJobPost>(prompt, {
    temperature: 0.6,
  });
}

// ======================================================
// Interview Report
// ======================================================

export interface InterviewReport {
  overallScore: number;
  recommendation: "STRONG_YES" | "YES" | "MAYBE" | "NO";
  summary: string;
  strengths: string[];
  concerns: string[];
  skillAssessment: {
    skill: string;
    rating: number;
    note: string;
  }[];
  communicationScore: number;
  technicalScore: number;
}

export async function generateInterviewReport(params: {
  jobTitle: string;
  jobDescription: string;
  candidateName: string;
  transcript: string;
}): Promise<InterviewReport> {
  const prompt = `You are a senior hiring manager reviewing an AI interview.

JOB TITLE: ${params.jobTitle}
JOB DESCRIPTION: ${params.jobDescription}
CANDIDATE: ${params.candidateName}

INTERVIEW TRANSCRIPT:
${params.transcript}

Return ONLY valid JSON:

{
  "overallScore": 0,
  "recommendation": "YES",
  "summary": "",
  "strengths": [],
  "concerns": [],
  "skillAssessment": [
    {
      "skill": "",
      "rating": 1,
      "note": ""
    }
  ],
  "communicationScore": 0,
  "technicalScore": 0
}`;

  return callGeminiJSON<InterviewReport>(prompt, {
    temperature: 0.3,
  });
}

// ======================================================
// Interview Question Generation
// ======================================================

export async function generateInterviewQuestions(params: {
  jobTitle: string;
  jobDescription: string;
  jobRequirements?: string | null;
  jobSkills?: string | null;
  count?: number;
}): Promise<string[]> {
  const count = params.count ?? 6;

  const prompt = `Generate ${count} professional AI voice interview questions.

JOB TITLE: ${params.jobTitle}

JOB DESCRIPTION:
${params.jobDescription}

REQUIREMENTS:
${params.jobRequirements || "N/A"}

SKILLS:
${params.jobSkills || "N/A"}

Return ONLY valid JSON:

{
  "questions": [
    "Question 1",
    "Question 2"
  ]
}`;

  const result = await callGeminiJSON<{
    questions: string[];
  }>(prompt, {
    temperature: 0.6,
  });

  return Array.isArray(result.questions)
    ? result.questions
    : [];
}