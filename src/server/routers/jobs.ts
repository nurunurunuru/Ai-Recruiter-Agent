import { z } from "zod";
import { createTRPCRouter, baseProcedure, adminProcedure } from "@/src/server/trpc";
import { generateJobPost, generateInterviewQuestions } from "@/src/lib/gemini";

export const jobsRouter = createTRPCRouter({
  // Admin: all jobs regardless of status
  getAll: adminProcedure.query(async ({ ctx }) => {
    return ctx.prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { candidates: true },
        },
      },
    });
  }),

  // Candidate portal: only ACTIVE jobs are visible to applicants
  getAllPublic: baseProcedure.query(async ({ ctx }) => {
    return ctx.prisma.job.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  }),

  getById: baseProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.job.findUnique({
        where: { id: input.id },
        include: {
          candidates: {
            orderBy: { createdAt: "desc" },
          },
          _count: {
            select: { candidates: true },
          },
        },
      });
    }),

  // Admin: ask Gemini to draft a full job post from just a title (+ optional dept/location)
  generateWithAI: adminProcedure
    .input(
      z.object({
        title: z.string().min(1),
        department: z.string().optional(),
        location: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      return generateJobPost(input);
    }),

  // Admin: ask Gemini to draft the voice-interview question set for this role
  generateQuestionsWithAI: adminProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        requirements: z.string().optional(),
        skills: z.string().optional(),
        count: z.number().min(3).max(12).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const questions = await generateInterviewQuestions({
        jobTitle: input.title,
        jobDescription: input.description,
        jobRequirements: input.requirements,
        jobSkills: input.skills,
        count: input.count,
      });
      return { questions };
    }),

  create: adminProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        requirements: z.string().optional(),
        responsibilities: z.string().optional(),
        skills: z.string().optional(),
        employmentType: z.string().optional(),
        experienceLevel: z.string().optional(),
        salaryRange: z.string().optional(),
        department: z.string().optional(),
        location: z.string().optional(),
        status: z.enum(["ACTIVE", "CLOSED", "DRAFT"]).default("ACTIVE"),
        aiGenerated: z.boolean().optional(),
        interviewQuestions: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { interviewQuestions, ...rest } = input;
      return ctx.prisma.job.create({
        data: {
          ...rest,
          interviewQuestions: interviewQuestions
            ? JSON.stringify(interviewQuestions)
            : undefined,
        },
      });
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        requirements: z.string().optional(),
        responsibilities: z.string().optional(),
        skills: z.string().optional(),
        employmentType: z.string().optional(),
        experienceLevel: z.string().optional(),
        salaryRange: z.string().optional(),
        department: z.string().optional(),
        location: z.string().optional(),
        status: z.enum(["ACTIVE", "CLOSED", "DRAFT"]).optional(),
        interviewQuestions: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, interviewQuestions, ...rest } = input;
      return ctx.prisma.job.update({
        where: { id },
        data: {
          ...rest,
          ...(interviewQuestions
            ? { interviewQuestions: JSON.stringify(interviewQuestions) }
            : {}),
        },
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.job.delete({
        where: { id: input.id },
      });
    }),

  getStats: adminProcedure.query(async ({ ctx }) => {
    const [active, total, candidates, pendingReview, interviewsDone] = await Promise.all([
      ctx.prisma.job.count({ where: { status: "ACTIVE" } }),
      ctx.prisma.job.count(),
      ctx.prisma.candidate.count(),
      ctx.prisma.candidate.count({ where: { status: "AI_REVIEWED" } }),
      ctx.prisma.candidate.count({ where: { status: "INTERVIEW_COMPLETED" } }),
    ]);
    return { active, total, candidates, pendingReview, interviewsDone };
  }),
});
