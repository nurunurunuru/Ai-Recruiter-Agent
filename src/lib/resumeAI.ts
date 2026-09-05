export interface ResumeAIAnalysis {
  matchScore: number;
  summary: string;
  strengths: string[];
  gaps: string[];
  recommendation: string;

  details?: {
    semanticScore?: number;
    skillScore?: number;
    matchedSkills?: string[];
    missingSkills?: string[];
    candidateExperience?: number | null;
    requestedExperience?: number | null;
    education?: string[];
  };
}

interface AnalyzeResumeInput {
  resumeText: string;
  jobTitle?: string;
  jobDescription?: string;
  requirements?: string;
  skills?: string;
  responsibilities?: string;
  experienceLevel?: string;
}

export async function analyzeResumeLocally(
  input: AnalyzeResumeInput
): Promise<ResumeAIAnalysis> {
  const serverUrl =
    process.env.RESUME_AI_SERVER_URL;

  const secret =
    process.env.RESUME_AI_SECRET;

  if (!serverUrl) {
    throw new Error(
      "RESUME_AI_SERVER_URL is not configured"
    );
  }

  if (!secret) {
    throw new Error(
      "RESUME_AI_SECRET is not configured"
    );
  }

  const cleanServerUrl = serverUrl.replace(
    /\/+$/,
    ""
  );

  const response = await fetch(
    `${cleanServerUrl}/analyze`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },

      body: JSON.stringify(input),

      // Prevent an indefinitely hanging request.
      signal: AbortSignal.timeout(120000),
    }
  );

  let data: any = null;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Resume AI server returned invalid JSON (${response.status})`
    );
  }

  if (!response.ok || !data?.success) {
    throw new Error(
      data?.error ||
        `Resume AI server error (${response.status})`
    );
  }

  if (!data.analysis) {
    throw new Error(
      "Resume AI server returned no analysis"
    );
  }

  return data.analysis as ResumeAIAnalysis;
}