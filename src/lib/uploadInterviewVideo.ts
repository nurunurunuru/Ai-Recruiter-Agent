import { supabase } from "@/src/lib/supabaseClient";

export async function uploadInterviewVideo(
  videoBlob: Blob,
  candidateName: string,
  jobTitle: string
) {
  try {
    const fileName = `${Date.now()}-${candidateName
      .replace(/\s+/g, "-")
      .toLowerCase()}.webm`;

    const filePath = `interviews/${fileName}`;

    const { error } = await supabase.storage
      .from("interview-videos")
      .upload(filePath, videoBlob, {
        contentType: "video/webm",
        upsert: false,
      });

    if (error) {
      console.error("Video upload error:", error);
      throw error;
    }

    const { data } = supabase.storage
      .from("interview-videos")
      .getPublicUrl(filePath);

    return {
      success: true,
      videoUrl: data.publicUrl,
      filePath,
      candidateName,
      jobTitle,
    };
  } catch (error) {
    console.error("Failed to upload interview video:", error);

    return {
      success: false,
      error,
    };
  }
}