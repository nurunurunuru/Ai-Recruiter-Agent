import { NextRequest, NextResponse } from "next/server";
import { getAuthServer } from "@/src/lib/authoption";
import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAuthServer();

  if (!session?.user) {
    return new NextResponse("Unauthorized", {
      status: 401,
    });
  }

  try {
    const { id } = await params;

    // Only admins can view candidate CVs
    if (session.user.role !== "ADMIN") {
      return new NextResponse("Forbidden", {
        status: 403,
      });
    }

    // Prevent path traversal
    if (!/^[a-f0-9-]+$/i.test(id)) {
      return new NextResponse("Invalid file", {
        status: 400,
      });
    }

    const filePath = path.join(
      process.cwd(),
      "uploads",
      "resumes",
      `${id}.pdf`
    );

    const file = await readFile(filePath);

    return new NextResponse(file, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    console.error("Resume read failed:", error);

    return new NextResponse("Resume not found", {
      status: 404,
    });
  }
}