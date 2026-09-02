import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, baseProcedure } from "@/src/server/trpc";

export const authRouter = createTRPCRouter({
  // Public self-registration — always creates a CANDIDATE account.
  // Admin accounts are created via the seed script, not this form.
  register: baseProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(6),
        phone: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.user.findUnique({
        where: { email: input.email },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An account with this email already exists.",
        });
      }

      const hashed = await bcrypt.hash(input.password, 10);
      const user = await ctx.prisma.user.create({
        data: {
          name: input.name,
          email: input.email,
          password: hashed,
          phone: input.phone,
          role: "CANDIDATE",
        },
      });

      return { id: user.id, email: user.email, name: user.name };
    }),
});
