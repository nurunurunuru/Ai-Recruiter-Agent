import { NextRequest, NextResponse } from "next/server";
import { getAuthServer } from "@/src/lib/authoption";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getAuthServer();

  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No file uploaded" },
        { status: 400 }
      );
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json(
        { error: "Please upload a PDF file" },
        { status: 400 }
      );
    }

    const MAX_SIZE = 8 * 1024 * 1024;

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: "File is too large. Maximum size is 8MB." },
        { status: 400 }
      );
    }

    const uploadDir = path.join(
      process.cwd(),
      "uploads",
      "resumes"
    );

    await mkdir(uploadDir, { recursive: true });

    const fileId = randomUUID();
    const fileName = `${fileId}.pdf`;

    const filePath = path.join(uploadDir, fileName);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await writeFile(filePath, buffer);

    const resumeUrl = `/api/resumes/${fileId}`;

    return NextResponse.json({
      success: true,
      resumeUrl,
      fileName: file.name,
    });
  } catch (error) {
    console.error("Resume upload failed:", error);

    return NextResponse.json(
      { error: "Failed to upload resume." },
      { status: 500 }
    );
  }
}