"use client";

import { cn } from "@/src/lib/utils";
import { uploadInterviewVideo } from "@/src/lib/uploadInterviewVideo";
import { useEffect, useRef, useState, useCallback } from "react";

type VoiceStatus =
  | "idle"
  | "connecting"
  | "speaking"
  | "listening"
  | "error";

interface RecruiterVoiceAgentProps {
  assistantId?: string;
  candidateName: string;
  candidateId: string;
  jobTitle: string;
  questions?: string[];
  onCallComplete?: (transcript: string, videoUrl?: string) => void;
  onCallStart?: () => void | Promise<void>;
  onCallEnd?: () => void;
  onSecurityViolation?: (reason: string) => void;
  className?: string;
}

export function RecruiterVoiceAgent({
  assistantId,
  candidateName,
  candidateId,
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

  const [silenceSecondsLeft, setSilenceSecondsLeft] =
    useState<number | null>(null);

  const [securityMessage, setSecurityMessage] =
    useState<string | null>(null);

  // Camera states
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraStarting, setCameraStarting] = useState(false);

  // Recording states
  const [isRecording, setIsRecording] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [recordingError, setRecordingError] =
    useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingCallIdRef = useRef<string | null>(null);

  const silenceTimerRef =
    useRef<ReturnType<typeof setInterval> | null>(null);

  const silenceStartedAtRef = useRef<number | null>(null);

  const securityViolationRef = useRef(false);

  const transcriptRef = useRef<string[]>([]);
  const completedRef = useRef(false);

  const vapiInstanceRef = useRef<{
    start: (
      id: string,
      overrides?: Record<string, unknown>
    ) => Promise<void>;

    stop: () => Promise<void>;

    send: (message: {
      type: "add-message";
      message: {
        role: "system" | "user" | "assistant";
        content: string;
      };
    }) => void;

    on: (event: string, cb: (...args: unknown[]) => void) => void;
  } | null>(null);

  const apiKey = process.env.NEXT_PUBLIC_VAPI_API_KEY;

  const defaultAssistantId =
    process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;

  const assistantIdToUse =
    assistantId || defaultAssistantId;

  /* =====================================================
     TRANSCRIPT SYNC
  ===================================================== */

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  /* =====================================================
     CAMERA FUNCTIONS
  ===================================================== */

  const stopCamera = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });

      cameraStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraReady(false);
  }, []);

  const startCamera = useCallback(async (): Promise<boolean> => {
    try {
      setCameraStarting(true);
      setCameraError(null);

      if (cameraStreamRef.current) {
        cameraStreamRef.current
          .getTracks()
          .forEach((track) => track.stop());

        cameraStreamRef.current = null;
      }

      const stream =
        await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",

            width: {
              ideal: 1280,
            },

            height: {
              ideal: 720,
            },
          },

          /*
            IMPORTANT:

            Camera stream-এ audio:true দিলে
            microphone + camera একসাথে record হবে।

            Vapi microphone আলাদাভাবে use করতে পারবে।
          */

          audio: true,
        });

      cameraStreamRef.current = stream;

      await new Promise((resolve) =>
        setTimeout(resolve, 100)
      );

      if (videoRef.current) {
        videoRef.current.srcObject = stream;

        try {
          await videoRef.current.play();
        } catch (error) {
          console.warn(
            "Video autoplay warning:",
            error
          );
        }
      }

      setCameraReady(true);
      setCameraStarting(false);

      return true;
    } catch (error) {
      console.error(
        "Camera access failed:",
        error
      );

      let message =
        "Camera and microphone access are required to start the AI interview.";

      if (error instanceof DOMException) {
        if (error.name === "NotAllowedError") {
          message =
            "Camera or microphone permission was denied. Please allow access and try again.";
        } else if (error.name === "NotFoundError") {
          message =
            "No camera or microphone was found on this device.";
        } else if (error.name === "NotReadableError") {
          message =
            "Your camera or microphone is currently being used by another application.";
        }
      }

      setCameraError(message);

      setCameraReady(false);
      setCameraStarting(false);

      return false;
    }
  }, []);

  /* =====================================================
     VIDEO RECORDING
  ===================================================== */

  const startRecording = useCallback(
    (callId: string) => {
      try {
        const stream = cameraStreamRef.current;

        if (!stream) {
          throw new Error(
            "Camera stream is not available for recording."
          );
        }

        recordedChunksRef.current = [];

        recordingCallIdRef.current = callId;

        setRecordingError(null);

        let mimeType = "";

        if (
          MediaRecorder.isTypeSupported(
            "video/webm;codecs=vp9,opus"
          )
        ) {
          mimeType =
            "video/webm;codecs=vp9,opus";
        } else if (
          MediaRecorder.isTypeSupported(
            "video/webm;codecs=vp8,opus"
          )
        ) {
          mimeType =
            "video/webm;codecs=vp8,opus";
        } else if (
          MediaRecorder.isTypeSupported(
            "video/webm"
          )
        ) {
          mimeType = "video/webm";
        }

        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined
        );

        recorder.ondataavailable = (event) => {
          if (
            event.data &&
            event.data.size > 0
          ) {
            recordedChunksRef.current.push(
              event.data
            );
          }
        };

        recorder.onerror = (event) => {
          console.error(
            "MediaRecorder error:",
            event
          );

          setRecordingError(
            "Video recording encountered an error."
          );
        };

        recorder.start(1000);

        mediaRecorderRef.current = recorder;

        setIsRecording(true);

        console.log(
          "🎥 Interview video recording started"
        );
      } catch (error) {
        console.error(
          "Failed to start recording:",
          error
        );

        setRecordingError(
          "Unable to start interview recording."
        );
      }
    },
    []
  );

  const stopRecordingAndUpload = useCallback(
    async (): Promise<string | undefined> => {
      return new Promise((resolve) => {
        const recorder =
          mediaRecorderRef.current;

        if (!recorder) {
          resolve(undefined);
          return;
        }

        const callId =
          recordingCallIdRef.current;

        recorder.onstop = async () => {
          try {
            setIsRecording(false);

            mediaRecorderRef.current = null;

            const chunks =
              recordedChunksRef.current;

            if (!chunks.length) {
              console.warn(
                "No video recording chunks found."
              );

              resolve(undefined);
              return;
            }

            const videoBlob = new Blob(
              chunks,
              {
                type:
                  recorder.mimeType ||
                  "video/webm",
              }
            );

            console.log(
              "🎥 Recording complete:",
              `${(videoBlob.size / 1024 / 1024).toFixed(
                2
              )} MB`
            );

            if (!callId) {
              console.warn(
                "No call ID available for video upload."
              );

              resolve(undefined);
              return;
            }

            setUploadingVideo(true);

            console.log(
              "☁️ Uploading interview video..."
            );

            const videoUrl =
              await uploadInterviewVideo(
                videoBlob,
                candidateId,
                callId
              );

            console.log(
              "✅ Video uploaded successfully:",
              videoUrl
            );

            recordedChunksRef.current = [];

            setUploadingVideo(false);

            resolve(videoUrl);
          } catch (error) {
            console.error(
              "Video upload failed:",
              error
            );

            setRecordingError(
              "Interview ended, but the video could not be uploaded."
            );

            setUploadingVideo(false);

            resolve(undefined);
          }
        };

        if (recorder.state !== "inactive") {
          recorder.stop();
        } else {
          resolve(undefined);
        }
      });
    },
    [candidateId]
  );

  /* =====================================================
     LOAD VAPI SDK
  ===================================================== */

  useEffect(() => {
    let mounted = true;

    async function loadVapi() {
      try {
        const VapiModule =
          await import("@vapi-ai/web");

        const Vapi =
          VapiModule.default ?? VapiModule;

        if (
          mounted &&
          typeof window !== "undefined"
        ) {
          (
            window as unknown as Record<
              string,
              unknown
            >
          ).__VapiClass = Vapi;

          setSdkReady(true);
        }
      } catch (err) {
        console.error(
          "Failed to load Vapi SDK:",
          err
        );
      }
    }

    loadVapi();

    return () => {
      mounted = false;

      if (silenceTimerRef.current) {
        clearInterval(
          silenceTimerRef.current
        );
      }

      if (mediaRecorderRef.current) {
        try {
          if (
            mediaRecorderRef.current.state !==
            "inactive"
          ) {
            mediaRecorderRef.current.stop();
          }
        } catch {}
      }

      if (vapiInstanceRef.current) {
        vapiInstanceRef.current
          .stop()
          .catch(() => {});

        vapiInstanceRef.current = null;
      }

      stopCamera();
    };
  }, [stopCamera]);

  /* =====================================================
     SILENCE TIMER
  ===================================================== */

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);

      silenceTimerRef.current = null;
    }

    silenceStartedAtRef.current = null;

    setSilenceSecondsLeft(null);
  }, []);

  const startSilenceTimer = useCallback(
    (vapi: {
      send: (message: {
        type: "add-message";
        message: {
          role: "system";
          content: string;
        };
      }) => void;
    }) => {
      clearSilenceTimer();

      silenceStartedAtRef.current =
        Date.now();

      setSilenceSecondsLeft(10);

      silenceTimerRef.current =
        setInterval(() => {
          const startedAt =
            silenceStartedAtRef.current;

          if (!startedAt) return;

          const elapsed = Math.floor(
            (Date.now() - startedAt) / 1000
          );

          const remaining = Math.max(
            0,
            10 - elapsed
          );

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
    },
    [clearSilenceTimer]
  );

  /* =====================================================
     SECURITY VIOLATION
  ===================================================== */

  const cancelForSecurityViolation =
    useCallback(
      async (reason?: string) => {
        if (
          securityViolationRef.current
        )
          return;

        securityViolationRef.current = true;

        clearSilenceTimer();

        setStatus("error");

        const finalReason =
          reason ||
          "Interview cancelled because you left the interview page or opened another browser tab/window. You cannot resume this interview.";

        try {
          if (vapiInstanceRef.current) {
            await vapiInstanceRef.current.stop();
          }
        } catch (error) {
          console.error(
            "Failed to stop interview:",
            error
          );
        } finally {
          vapiInstanceRef.current = null;

          /*
            STOP RECORDING FIRST
          */

          await stopRecordingAndUpload();

          stopCamera();

          setSecurityMessage(finalReason);

          onSecurityViolation?.(
            finalReason
          );
        }
      },
      [
        clearSilenceTimer,
        onSecurityViolation,
        stopCamera,
        stopRecordingAndUpload,
      ]
    );

  /* =====================================================
     START CALL
  ===================================================== */

  const startCall = useCallback(async () => {
    if (!apiKey) {
      setStatus("error");

      console.error(
        "Vapi API key not configured"
      );

      return;
    }

    if (!assistantIdToUse) {
      setStatus("error");

      console.error(
        "Vapi assistant ID not configured"
      );

      return;
    }

    if (!sdkReady) {
      setStatus("error");

      console.error(
        "Vapi SDK not loaded yet"
      );

      return;
    }

    const VapiClass = (
      window as unknown as Record<
        string,
        unknown
      >
    ).__VapiClass as
      | (new (key: string) => {
          start: (
            id: string,
            overrides?: Record<string, unknown>
          ) => Promise<void>;

          stop: () => Promise<void>;

          send: (message: {
            type: "add-message";
            message: {
              role:
                | "system"
                | "user"
                | "assistant";
              content: string;
            };
          }) => void;

          on: (
            event: string,
            cb: (...args: unknown[]) => void
          ) => void;
        })
      | undefined;

    if (!VapiClass) {
      setStatus("error");

      console.error(
        "Vapi SDK class not loaded yet"
      );

      return;
    }

    try {
      setStatus("connecting");

      securityViolationRef.current = false;

      completedRef.current = false;

      setSecurityMessage(null);

      setRecordingError(null);

      clearSilenceTimer();

      setTranscript([]);

      transcriptRef.current = [];

      /*
        CAMERA + MICROPHONE
      */

      const cameraStarted =
        await startCamera();

      if (!cameraStarted) {
        setStatus("idle");

        return;
      }

      /*
        CREATE DATABASE CALL
      */

      const callResult =
        await onCallStart?.();

      /*
        IMPORTANT

        Parent component currently returns nothing.

        তাই আমরা temporary unique ID ব্যবহার করছি
        যদি call ID পাওয়া না যায়।

        NEXT STEP-এ PortalInterviewClient
        change করে real call.id পাঠাবো।
      */

      const generatedCallId =
        typeof callResult === "string"
          ? callResult
          : `temp-${Date.now()}`;

      /*
        START VIDEO RECORDING
      */

      startRecording(generatedCallId);

      /*
        START VAPI
      */

      const vapiInstance =
        new VapiClass(apiKey);

      vapiInstanceRef.current =
        vapiInstance;

      vapiInstance.on(
        "call-start",
        () => {
          setStatus("speaking");
        }
      );

      vapiInstance.on(
        "call-end",
        async () => {
          clearSilenceTimer();

          if (
            !securityViolationRef.current &&
            !completedRef.current
          ) {
            completedRef.current = true;

            const videoUrl =
              await stopRecordingAndUpload();

            const finalTranscript =
              transcriptRef.current.join("\n");

            if (
              finalTranscript.length > 0
            ) {
              onCallComplete?.(
                finalTranscript,
                videoUrl
              );
            }
          }

          stopCamera();

          setStatus(
            securityViolationRef.current
              ? "error"
              : "idle"
          );

          onCallEnd?.();

          vapiInstanceRef.current =
            null;
        }
      );

      /*
        CANDIDATE STARTS SPEAKING
      */

      vapiInstance.on(
        "speech-start",
        () => {
          clearSilenceTimer();

          setStatus("listening");
        }
      );

      vapiInstance.on(
        "speech-end",
        () => {
          setStatus("listening");
        }
      );

      /*
        TRANSCRIPT
      */

      vapiInstance.on(
        "message",
        (message: unknown) => {
          const msg =
            message as Record<
              string,
              unknown
            >;

          if (
            msg.type === "transcript" &&
            msg.transcript
          ) {
            const role =
              msg.role === "assistant"
                ? "Recruiter"
                : "Candidate";

            const transcriptType =
              msg.transcriptType;

            const text =
              String(
                msg.transcript
              ).trim();

            if (
              transcriptType === "final" ||
              transcriptType === undefined
            ) {
              const newLine =
                `${role}: ${text}`;

              setTranscript((prev) => {
                const updated = [
                  ...prev,
                  newLine,
                ];

                transcriptRef.current =
                  updated;

                return updated;
              });
            }

            /*
              AI FINISHED SPEAKING
            */

            if (
              msg.role === "assistant" &&
              (transcriptType === "final" ||
                transcriptType === undefined)
            ) {
              startSilenceTimer(
                vapiInstance
              );

              setStatus("listening");
            }
          }
        }
      );

      vapiInstance.on(
        "error",
        () => {
          clearSilenceTimer();

          setStatus("error");

          void stopRecordingAndUpload();

          stopCamera();
        }
      );

      await vapiInstance.start(
        assistantIdToUse,
        {
          variableValues: {
            candidateName,

            jobTitle,

            questions:
              questions &&
              questions.length > 0
                ? questions
                    .map(
                      (q, i) =>
                        `${i + 1}. ${q}`
                    )
                    .join("\n")
                : "Ask general questions about the candidate's background and fit for the role.",
          },
        }
      );
    } catch (error) {
      console.error(
        "Failed to start call:",
        error
      );

      await stopRecordingAndUpload();

      stopCamera();

      setStatus("error");
    }
  }, [
    apiKey,
    assistantIdToUse,
    sdkReady,
    candidateName,
    jobTitle,
    questions,
    onCallStart,
    onCallEnd,
    clearSilenceTimer,
    startSilenceTimer,
    startCamera,
    stopCamera,
    startRecording,
    stopRecordingAndUpload,
  ]);

  /* =====================================================
     TAB SWITCH DETECTION
  ===================================================== */

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "hidden" &&
        vapiInstanceRef.current
      ) {
        void cancelForSecurityViolation(
          "Interview cancelled because you left the interview page or opened another browser tab/window. You cannot resume this interview."
        );
      }
    };

    document.addEventListener(
      "visibilitychange",
      handleVisibilityChange
    );

    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
    };
  }, [cancelForSecurityViolation]);

  /* =====================================================
     CAMERA SECURITY MONITORING
  ===================================================== */

  useEffect(() => {
    const checkCamera = () => {
      if (
        vapiInstanceRef.current &&
        cameraStreamRef.current
      ) {
        const videoTrack =
          cameraStreamRef.current
            .getVideoTracks()[0];

        if (
          !videoTrack ||
          videoTrack.readyState === "ended"
        ) {
          void cancelForSecurityViolation(
            "Interview cancelled because the required camera was turned off or disconnected."
          );
        }
      }
    };

    const interval =
      setInterval(checkCamera, 1000);

    return () =>
      clearInterval(interval);
  }, [cancelForSecurityViolation]);

  /* =====================================================
     STOP CALL
  ===================================================== */

  const stopCall = useCallback(
    async () => {
      try {
        clearSilenceTimer();

        if (vapiInstanceRef.current) {
          await vapiInstanceRef.current.stop();
        }

        /*
          call-end event handles:
          recording stop
          video upload
          transcript submit
        */

        if (securityViolationRef.current)
          return;

        setStatus("idle");
      } catch (error) {
        console.error(
          "Failed to stop call:",
          error
        );

        await stopRecordingAndUpload();

        stopCamera();
      }
    },
    [
      clearSilenceTimer,
      stopRecordingAndUpload,
      stopCamera,
    ]
  );

  const isActive =
    status !== "idle" &&
    status !== "error";

  return (
    <div
      className={cn(
        "rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden",
        className
      )}
    >
      {/* HEADER */}

      <div className="px-6 py-4 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              AI Recruiter Video Interview
            </h3>

            <p className="text-sm text-gray-500 mt-0.5">
              Screening {candidateName} for {jobTitle}
            </p>
          </div>

          <div className="flex items-center gap-4">

            {/* RECORDING */}

            {isRecording && (
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />

                <span className="text-xs font-semibold text-red-600">
                  RECORDING
                </span>
              </div>
            )}

            {/* CAMERA */}

            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "w-2.5 h-2.5 rounded-full",
                  cameraReady
                    ? "bg-red-500 animate-pulse"
                    : "bg-gray-400"
                )}
              />

              <span className="text-xs font-medium text-gray-600">
                {cameraReady
                  ? "Camera ON"
                  : "Camera OFF"}
              </span>
            </div>

            {/* VOICE */}

            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "w-2 h-2 rounded-full",

                  status === "idle" &&
                    "bg-gray-400",

                  status === "connecting" &&
                    "bg-yellow-400 animate-pulse",

                  status === "speaking" &&
                    "bg-green-500 animate-pulse",

                  status === "listening" &&
                    "bg-blue-500 animate-pulse",

                  status === "error" &&
                    "bg-red-500"
                )}
              />

              <span className="text-xs font-medium text-gray-600 capitalize">
                {status === "connecting"
                  ? "Connecting..."
                  : status === "speaking"
                  ? "AI Speaking"
                  : status === "listening"
                  ? "Listening"
                  : status === "error"
                  ? "Error"
                  : "Ready"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* SECURITY MESSAGE */}

      {securityMessage && (
        <div className="px-6 py-4 bg-red-50 border-b border-red-200">
          <p className="text-sm font-semibold text-red-800">
            Interview Cancelled
          </p>

          <p className="text-xs text-red-700 mt-1">
            {securityMessage}
          </p>
        </div>
      )}

      {/* CAMERA ERROR */}

      {cameraError && (
        <div className="px-6 py-4 bg-red-50 border-b border-red-200">
          <p className="text-sm font-semibold text-red-800">
            Camera Required
          </p>

          <p className="text-xs text-red-700 mt-1">
            {cameraError}
          </p>
        </div>
      )}

      {/* RECORDING ERROR */}

      {recordingError && (
        <div className="px-6 py-3 bg-yellow-50 border-b border-yellow-200">
          <p className="text-xs text-yellow-800">
            {recordingError}
          </p>
        </div>
      )}

      {/* UPLOADING */}

      {uploadingVideo && (
        <div className="px-6 py-3 bg-blue-50 border-b border-blue-200">
          <p className="text-xs text-blue-800">
            Uploading interview video. Please wait...
          </p>
        </div>
      )}

      {/* VIDEO AREA */}

      <div className="bg-gray-950 p-4">
        <div className="relative w-full aspect-video max-h-[420px] rounded-xl overflow-hidden bg-black flex items-center justify-center">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={cn(
              "w-full h-full object-cover transform scale-x-[-1]",
              !cameraReady && "hidden"
            )}
          />

          {!cameraReady && (
            <div className="text-center text-gray-400 px-6">
              <svg
                className="w-14 h-14 mx-auto mb-3 opacity-60"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M4 6h11a2 2 0 012 2v8a2 2 0 00-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2V8a2 2 0 00-2-2z"
                />
              </svg>

              <p className="text-sm">
                Your camera will turn on when the interview starts.
              </p>
            </div>
          )}

          {cameraReady && (
            <>
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/60 text-white px-3 py-1.5 rounded-full">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />

                <span className="text-xs font-semibold">
                  LIVE CAMERA
                </span>
              </div>

              {isRecording && (
                <div className="absolute top-4 right-4 flex items-center gap-2 bg-red-600 text-white px-3 py-1.5 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse" />

                  <span className="text-xs font-bold">
                    REC
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* SECURITY NOTICE */}

      {!isActive && !securityMessage && (
        <div className="px-6 py-3 bg-blue-50 border-b border-blue-100">
          <p className="text-xs text-blue-800">
            <strong>Interview Requirements:</strong>{" "}
            Camera and microphone access are required.
            Please remain on this interview page.
            This interview session is video recorded.
            Leaving the browser tab or turning off the camera
            may automatically cancel your interview.
          </p>
        </div>
      )}

      {/* QUESTION PREVIEW */}

      {questions &&
        questions.length > 0 &&
        status === "idle" &&
        !securityMessage && (
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              This interview will cover {questions.length} question
              {questions.length !== 1 ? "s" : ""}
            </p>

            <ol className="text-sm text-gray-600 space-y-1 list-decimal list-inside">
              {questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          </div>
        )}

      {/* SILENCE TIMER */}

      {isActive &&
        silenceSecondsLeft !== null && (
          <div className="px-6 py-2 bg-amber-50 border-b border-amber-100 text-center">
            <p className="text-xs font-medium text-amber-800">
              No response detected. Next question in{" "}
              {silenceSecondsLeft}s
            </p>
          </div>
        )}

      {/* TRANSCRIPT */}

      <div className="px-6 py-4 max-h-56 overflow-y-auto space-y-2">
        {transcript.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">
            {status === "idle"
              ? 'Click "Start Video Interview" to begin.'
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

      {/* CONTROLS */}

      <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
        <div>
          {isActive ? (
            <button
              onClick={stopCall}
              disabled={uploadingVideo}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              End Interview
            </button>
          ) : (
            <button
              onClick={startCall}
              disabled={
                !apiKey ||
                !assistantIdToUse ||
                !sdkReady ||
                cameraStarting ||
                !!securityMessage ||
                uploadingVideo
              }
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent-600 text-white text-sm font-semibold hover:bg-accent-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cameraStarting ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Starting Camera...
                </>
              ) : (
                <>
                  Start Video Interview
                </>
              )}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={volume}
            onChange={(e) =>
              setVolume(
                parseFloat(e.target.value)
              )
            }
            className="w-20 h-1 accent-primary-600"
          />
        </div>
      </div>

      {/* CONFIG */}

      {(!apiKey || !assistantIdToUse) && (
        <div className="px-6 py-3 bg-yellow-50 border-t border-yellow-200">
          <p className="text-xs text-yellow-700">
            {!apiKey && !assistantIdToUse
              ? "Set NEXT_PUBLIC_VAPI_API_KEY and NEXT_PUBLIC_VAPI_ASSISTANT_ID in your .env file."
              : !apiKey
              ? "Set NEXT_PUBLIC_VAPI_API_KEY in your .env file."
              : "Set NEXT_PUBLIC_VAPI_ASSISTANT_ID in your .env file."}
          </p>
        </div>
      )}
    </div>
  );
}