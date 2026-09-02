"use client";

import { cn } from "@/src/lib/utils";
import { useEffect, useRef, useState, useCallback } from "react";

type VoiceStatus = "idle" | "connecting" | "speaking" | "listening" | "error";

interface RecruiterVoiceAgentProps {
  assistantId?: string;
  candidateName: string;
  jobTitle: string;
  questions?: string[];
  onCallComplete?: (transcript: string) => void;
  onCallStart?: () => void | Promise<void>;
  onCallEnd?: () => void;
  onSecurityViolation?: (reason: string) => void;
  className?: string;
}

export function RecruiterVoiceAgent({
  assistantId,
  candidateName,
  jobTitle,
  questions,
  onCallComplete,
  onCallStart,
  onCallEnd,
  onSecurityViolation,
  className,
}: RecruiterVoiceAgentProps) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<string[]>([]);
  const [volume, setVolume] = useState(1);
  const [sdkReady, setSdkReady] = useState(false);
  const [silenceSecondsLeft, setSilenceSecondsLeft] = useState<number | null>(null);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);

  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const securityViolationRef = useRef(false);
  const vapiInstanceRef = useRef<{
    start: (id: string, overrides?: Record<string, unknown>) => Promise<void>;
    stop: () => Promise<void>;
    send: (message: {
      type: "add-message";
      message: { role: "system" | "user" | "assistant"; content: string };
    }) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
  } | null>(null);

  const apiKey = process.env.NEXT_PUBLIC_VAPI_API_KEY;
  const defaultAssistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
  const assistantIdToUse = assistantId || defaultAssistantId;

  // Dynamically import the Vapi SDK
  useEffect(() => {
    let mounted = true;

    async function loadVapi() {
      try {
        const VapiModule = await import("@vapi-ai/web");
        const Vapi = VapiModule.default ?? VapiModule;

        if (mounted && typeof window !== "undefined") {
          // Store the Vapi class so we can instantiate it later
          (window as unknown as Record<string, unknown>).__VapiClass = Vapi;
          setSdkReady(true);
        }
      } catch (err) {
        console.error("Failed to load Vapi SDK:", err);
      }
    }

    loadVapi();

    return () => {
      mounted = false;
      clearSilenceTimer();
      if (vapiInstanceRef.current) {
        vapiInstanceRef.current.stop().catch(() => {});
        vapiInstanceRef.current = null;
      }
    };
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    silenceStartedAtRef.current = null;
    setSilenceSecondsLeft(null);
  }, []);

  const startSilenceTimer = useCallback((vapi: {
    send: (message: {
      type: "add-message";
      message: { role: "system"; content: string };
    }) => void;
  }) => {
    clearSilenceTimer();
    silenceStartedAtRef.current = Date.now();
    setSilenceSecondsLeft(10);

    silenceTimerRef.current = setInterval(() => {
      const startedAt = silenceStartedAtRef.current;
      if (!startedAt) return;

      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const remaining = Math.max(0, 10 - elapsed);
      setSilenceSecondsLeft(remaining);

      if (remaining <= 0) {
        clearSilenceTimer();

        vapi.send({
          type: "add-message",
          message: {
            role: "system",
            content:
              "The candidate has been silent for 10 seconds after your last interview question. Do not wait any longer. If the candidate has not answered, politely move to the next unanswered interview question. Do not repeat the previous question. If there are no questions left, conclude the interview professionally.",
          },
        });
      }
    }, 250);
  }, [clearSilenceTimer]);

  const startCall = useCallback(async () => {
    if (!apiKey) {
      setStatus("error");
      console.error("Vapi API key not configured");
      return;
    }
    if (!assistantIdToUse) {
      setStatus("error");
      console.error("Vapi assistant ID not configured");
      return;
    }

    const VapiClass = (window as unknown as Record<string, unknown>)
      .__VapiClass as new (key: string) => {
      start: (id: string, overrides?: Record<string, unknown>) => Promise<void>;
      stop: () => Promise<void>;
      send: (message: {
        type: "add-message";
        message: { role: "system" | "user" | "assistant"; content: string };
      }) => void;
      on: (event: string, cb: (...args: unknown[]) => void) => void;
    };

    if (!VapiClass) {
      setStatus("error");
      console.error("Vapi SDK not loaded yet");
      return;
    }

    try {
      setStatus("connecting");
      securityViolationRef.current = false;
      setSecurityMessage(null);
      clearSilenceTimer();
      await onCallStart?.();

      const vapiInstance = new VapiClass(apiKey);
      vapiInstanceRef.current = vapiInstance;

      vapiInstance.on("call-start", () => {
        setStatus("speaking");
      });

      vapiInstance.on("call-end", () => {
        clearSilenceTimer();
        setStatus(securityViolationRef.current ? "error" : "idle");
        onCallEnd?.();
        vapiInstanceRef.current = null;
      });

      // Vapi's speech-start event is emitted when the candidate starts speaking.
      // Any candidate speech cancels the 10-second unanswered-question timer.
      vapiInstance.on("speech-start", () => {
        clearSilenceTimer();
        setStatus("listening");
      });

      vapiInstance.on("speech-end", () => {
        setStatus("listening");
      });

      vapiInstance.on("message", (message: unknown) => {
        const msg = message as Record<string, unknown>;

        if (msg.type === "transcript" && msg.transcript) {
          const role = msg.role === "assistant" ? "Recruiter" : "Candidate";
          const transcriptType = msg.transcriptType;
          const text = String(msg.transcript).trim();

          // Only store final transcript turns so partial transcripts don't
          // duplicate the interview transcript.
          if (transcriptType === "final" || transcriptType === undefined) {
            setTranscript((prev) => [...prev, `${role}: ${text}`]);
          }

          // When the AI finishes an utterance/question, start a 10-second
          // candidate-response timer. Candidate speech cancels this timer.
          if (msg.role === "assistant" && (transcriptType === "final" || transcriptType === undefined)) {
            startSilenceTimer(vapiInstance);
            setStatus("listening");
          }
        }
      });

      vapiInstance.on("error", () => {
        clearSilenceTimer();
        setStatus("error");
      });

      await vapiInstance.start(assistantIdToUse, {
        variableValues: {
          candidateName,
          jobTitle,
          questions:
            questions && questions.length > 0
              ? questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
              : "Ask general questions about the candidate's background and fit for the role.",
        },
      });
    } catch (error) {
      console.error("Failed to start call:", error);
      setStatus("error");
    }
  }, [
    apiKey,
    assistantIdToUse,
    candidateName,
    jobTitle,
    questions,
    onCallStart,
    onCallEnd,
    clearSilenceTimer,
    startSilenceTimer,
  ]);

  const cancelForSecurityViolation = useCallback(async () => {
    if (securityViolationRef.current) return;

    securityViolationRef.current = true;
    clearSilenceTimer();
    setStatus("error");

    try {
      if (vapiInstanceRef.current) {
        await vapiInstanceRef.current.stop();
      }
    } catch (error) {
      console.error("Failed to stop interview after security violation:", error);
    } finally {
      vapiInstanceRef.current = null;
      const reason =
        "Interview cancelled because you left the interview page or opened another browser tab/window. You cannot resume this interview.";
      setSecurityMessage(reason);
      onSecurityViolation?.(reason);
    }
  }, [clearSilenceTimer, onSecurityViolation]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && vapiInstanceRef.current) {
        void cancelForSecurityViolation();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cancelForSecurityViolation]);

  const stopCall = useCallback(async () => {
    try {
      clearSilenceTimer();

      if (vapiInstanceRef.current) {
        await vapiInstanceRef.current.stop();
      }

      if (securityViolationRef.current) return;

      setStatus("idle");
      onCallEnd?.();
      if (transcript.length > 0) {
        onCallComplete?.(transcript.join("\n"));
      }
    } catch (error) {
      console.error("Failed to stop call:", error);
    }
  }, [clearSilenceTimer, onCallEnd, onCallComplete, transcript]);

  const isActive = status !== "idle" && status !== "error";

  return (
    <div
      className={cn(
        "rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              AI Recruiter Voice Agent
            </h3>
            <p className="text-sm text-gray-500 mt-0.5">
              Screening {candidateName} for {jobTitle}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  status === "idle" && "bg-gray-400",
                  status === "connecting" && "bg-yellow-400 animate-pulse",
                  status === "speaking" && "bg-green-500 animate-pulse",
                  status === "listening" && "bg-blue-500 animate-pulse",
                  status === "error" && "bg-red-500"
                )}
              />
              <span className="text-xs font-medium text-gray-600 capitalize">
                {status === "connecting"
                  ? "Connecting..."
                  : status === "speaking"
                  ? "Speaking"
                  : status === "listening"
                  ? "Listening"
                  : status === "error"
                  ? "Error"
                  : "Idle"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {securityMessage && (
        <div className="px-6 py-4 bg-red-50 border-b border-red-200">
          <p className="text-sm font-semibold text-red-800">Interview Cancelled</p>
          <p className="text-xs text-red-700 mt-1">{securityMessage}</p>
        </div>
      )}

      {/* Job-specific question preview */}
      {questions && questions.length > 0 && status === "idle" && (
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            This interview will cover {questions.length} question{questions.length !== 1 ? "s" : ""}
          </p>
          <ol className="text-sm text-gray-600 space-y-1 list-decimal list-inside">
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Visualizer */}
      {isActive && (
        <div className="px-6 py-3 bg-gradient-to-r from-primary-50 to-accent-50 border-b border-gray-100">
          <div className="flex items-center justify-center gap-1 h-8">
            {Array.from({ length: 20 }).map((_, i) => (
              <div
                key={i}
                className="w-1 rounded-full bg-primary-400"
                style={{
                  height: `${Math.random() * 24 + 4}px`,
                  animationDelay: `${i * 0.1}s`,
                  animationDuration: "0.8s",
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Anti-cheating / silence timer */}
      {isActive && silenceSecondsLeft !== null && (
        <div className="px-6 py-2 bg-amber-50 border-b border-amber-100 text-center">
          <p className="text-xs font-medium text-amber-800">
            No response detected. Next question in {silenceSecondsLeft}s
          </p>
        </div>
      )}

      {/* Transcript area */}
      <div className="px-6 py-4 max-h-48 overflow-y-auto space-y-2">
        {transcript.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">
            {status === "idle"
              ? 'Click "Start Screening Call" to begin the interview'
              : "Waiting for the conversation to start..."}
          </p>
        ) : (
          transcript.map((line, i) => (
            <p
              key={i}
              className={cn(
                "text-sm",
                line.startsWith("Recruiter:")
                  ? "text-primary-700 font-medium"
                  : "text-gray-700"
              )}
            >
              {line}
            </p>
          ))
        )}
      </div>

      {/* Controls */}
      <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isActive ? (
            <button
              onClick={stopCall}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
              End Call
            </button>
          ) : (
            <button
              onClick={startCall}
              disabled={!apiKey || !assistantIdToUse || !sdkReady}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                />
              </svg>
              {sdkReady ? "Start Screening Call" : "Loading SDK..."}
            </button>
          )}
        </div>

        {/* Volume control */}
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
            />
          </svg>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-20 h-1 accent-primary-600"
          />
        </div>
      </div>

      {/* Setup warning */}
      {(!apiKey || !assistantIdToUse) && (
        <div className="px-6 py-3 bg-yellow-50 border-t border-yellow-200">
          <p className="text-xs text-yellow-700">
            {!apiKey && !assistantIdToUse
              ? "Set NEXT_PUBLIC_VAPI_API_KEY and NEXT_PUBLIC_VAPI_ASSISTANT_ID in your .env file to enable voice calls."
              : !apiKey
              ? "Set NEXT_PUBLIC_VAPI_API_KEY in your .env file to enable voice calls."
              : "Set NEXT_PUBLIC_VAPI_ASSISTANT_ID in your .env file to enable voice calls."}
          </p>
        </div>
      )}
    </div>
  );
}
