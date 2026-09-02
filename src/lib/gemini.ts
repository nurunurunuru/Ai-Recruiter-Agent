// Thin wrapper around the Google Gemini API (generativelanguage.googleapis.com).
// Requires GEMINI_API_KEY in the environment. Get one free at https://aistudio.google.com/apikey

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

interface GeminiCallOptions {
  systemInstruction?: string;
  temperature?: number;
  jsonSchema?: object; // if provided, asks Gemini to respond with matching JSON
}

/**
 * Calls Gemini with a prompt and returns the raw text response.
 * Throws if GEMINI_API_KEY isn't configured or the call fails.
 */
export async function callGemini(
  prompt: string,
  options: GeminiCallOptions = {}
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to your .env file (see https://aistudio.google.com/apikey)."
    );
  }

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.4,
      ...(options.jsonSchema
        ? { responseMimeType: "application/json", responseSchema: options.jsonSchema }
        : {}),
    },
  };

  if (options.systemInstruction) {
    body.systemInstruction = {
      role: "system",
      parts: [{ text: options.systemInstruction }],
    };
  }

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini API returned an empty response.");
  }
  return text;
}

/** Calls Gemini and parses the response as JSON, stripping any ```json fences. */
export async function callGeminiJSON<T = unknown>(
  prompt: string,
  options: GeminiCallOptions = {}
): Promise<T> {
  const raw = await callGemini(prompt, options);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`Failed to parse Gemini JSON response: ${cleaned.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Domain-specific helpers
// ---------------------------------------------------------------------------

export interface ResumeAnalysis {
  matchScore: number; // 0-100
  summary: string;
  strengths: string[];
  gaps: string[];
  recommendation: "STRONG_MATCH" | "GOOD_MATCH" | "PARTIAL_MATCH" | "WEAK_MATCH";
}

export async function analyzeResume(params: {
  jobTitle: string;
  jobDescription: string;
  jobRequirements?: string | null;
  jobSkills?: string | null;
  resumeText: string;
}): Promise<ResumeAnalysis> {
  const prompt = `You are an expert technical recruiter. Compare the candidate's resume against the job below and score how well they match.

JOB TITLE: ${params.jobTitle}
JOB DESCRIPTION: ${params.jobDescription}
REQUIREMENTS: ${params.jobRequirements || "N/A"}
KEY SKILLS: ${params.jobSkills || "N/A"}

CANDIDATE RESUME:
${params.resumeText}

Respond ONLY with a JSON object, no markdown, matching exactly this shape:
{
  "matchScore": <integer 0-100, how well the candidate matches the job>,
  "summary": "<2-3 sentence overall summary>",
  "strengths": ["<point>", "..."],
  "gaps": ["<point>", "..."],
  "recommendation": "STRONG_MATCH" | "GOOD_MATCH" | "PARTIAL_MATCH" | "WEAK_MATCH"
}`;

  return callGeminiJSON<ResumeAnalysis>(prompt, { temperature: 0.3 });
}

export interface GeneratedJobPost {
  description: string;
  requirements: string;
  responsibilities: string;
  skills: string; // comma separated
  employmentType: string;
  experienceLevel: string;
  salaryRange: string;
}

export async function generateJobPost(params: {
  title: string;
  department?: string;
  location?: string;
}): Promise<GeneratedJobPost> {
  const prompt = `Write a complete, professional job posting for the role below.

JOB TITLE: ${params.title}
DEPARTMENT: ${params.department || "N/A"}
LOCATION: ${params.location || "N/A"}

Respond ONLY with a JSON object, no markdown, matching exactly this shape:
{
  "description": "<3-5 paragraph engaging job description>",
  "requirements": "<bullet list as plain text, one requirement per line, prefixed with '- '>",
  "responsibilities": "<bullet list as plain text, one responsibility per line, prefixed with '- '>",
  "skills": "<comma separated list of 6-10 key skills>",
  "employmentType": "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERNSHIP",
  "experienceLevel": "ENTRY" | "MID" | "SENIOR" | "LEAD",
  "salaryRange": "<a reasonable market salary range as plain text, e.g. '$70,000 - $95,000/year'>"
}`;

  return callGeminiJSON<GeneratedJobPost>(prompt, { temperature: 0.6 });
}

export interface InterviewReport {
  overallScore: number; // 0-100
  recommendation: "STRONG_YES" | "YES" | "MAYBE" | "NO";
  summary: string;
  strengths: string[];
  concerns: string[];
  skillAssessment: { skill: string; rating: number; note: string }[];
  communicationScore: number; // 0-100
  technicalScore: number; // 0-100
}

export async function generateInterviewReport(params: {
  jobTitle: string;
  jobDescription: string;
  candidateName: string;
  transcript: string;
}): Promise<InterviewReport> {
  const prompt = `You are a senior hiring manager reviewing an AI-conducted voice screening interview transcript. Produce a structured, objective evaluation.

JOB TITLE: ${params.jobTitle}
JOB DESCRIPTION: ${params.jobDescription}
CANDIDATE: ${params.candidateName}

TRANSCRIPT:
${params.transcript}

Respond ONLY with a JSON object, no markdown, matching exactly this shape:
{
  "overallScore": <integer 0-100>,
  "recommendation": "STRONG_YES" | "YES" | "MAYBE" | "NO",
  "summary": "<3-4 sentence overall summary of interview performance>",
  "strengths": ["<point>", "..."],
  "concerns": ["<point>", "..."],
  "skillAssessment": [{ "skill": "<skill name>", "rating": <1-5>, "note": "<short note>" }],
  "communicationScore": <integer 0-100>,
  "technicalScore": <integer 0-100>
}`;

  return callGeminiJSON<InterviewReport>(prompt, { temperature: 0.3 });
}

// ---------------------------------------------------------------------------
// Interview question generation (per-job voice interview question set)
// ---------------------------------------------------------------------------

export async function generateInterviewQuestions(params: {
  jobTitle: string;
  jobDescription: string;
  jobRequirements?: string | null;
  jobSkills?: string | null;
  count?: number;
}): Promise<string[]> {
  const count = params.count ?? 6;
  const prompt = `You are designing a short AI voice screening interview for the role below.
Write ${count} clear, conversational interview questions a voice AI should ask a candidate.
Mix in: 1-2 background/experience questions, 2-3 role-specific/technical questions based on the
requirements and skills, and 1 behavioral/situational question. Keep each question a single
sentence, natural to say out loud, and self-contained (no "as mentioned above").

JOB TITLE: ${params.jobTitle}
JOB DESCRIPTION: ${params.jobDescription}
REQUIREMENTS: ${params.jobRequirements || "N/A"}
KEY SKILLS: ${params.jobSkills || "N/A"}

Respond ONLY with a JSON object, no markdown, matching exactly this shape:
{
  "questions": ["<question 1>", "<question 2>", ...]
}`;

  const result = await callGeminiJSON<{ questions: string[] }>(prompt, { temperature: 0.6 });
  return result.questions;
}

