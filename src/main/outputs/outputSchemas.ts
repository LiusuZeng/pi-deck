import { z } from "zod";

export const OUTPUT_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a contained POSIX relative path.",
  );

export const outputFileSchema = z
  .object({
    path: relativePathSchema,
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict();

export const revisionSchema = z
  .object({
    schemaVersion: z.literal(OUTPUT_SCHEMA_VERSION),
    outputId: idSchema,
    revisionId: idSchema,
    displayNumber: z.number().int().positive(),
    createdAtMs: z.number().int().nonnegative(),
    primaryFile: relativePathSchema,
    files: z.array(outputFileSchema).min(1).max(100),
    origin: z.enum(["agent", "manual-save", "import"]),
    publicationAttemptId: idSchema,
  })
  .strict()
  .superRefine((revision, ctx) => {
    const paths = new Set<string>();
    for (const [index, file] of revision.files.entries()) {
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "Duplicate file path.",
        });
      }
      paths.add(file.path);
    }
    if (!paths.has(revision.primaryFile)) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryFile"],
        message: "Primary file is not in the inventory.",
      });
    }
  });

export const outputSchema = z
  .object({
    schemaVersion: z.literal(OUTPUT_SCHEMA_VERSION),
    outputId: idSchema,
    workspaceId: idSchema,
    title: z.string().min(1).max(240),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    currentRevisionId: idSchema,
    currentDisplayNumber: z.number().int().positive(),
  })
  .strict();

export const reviewRecordSchema = z
  .object({
    revisionId: idSchema,
    actor: z.literal("user"),
    createdAtMs: z.number().int().nonnegative(),
    action: z.enum(["accepted", "changes-requested", "reopened", "note"]),
    note: z.string().max(16_384).optional(),
  })
  .strict();

/** Review decisions are user-authored records; publication code never creates them. */
export const reviewsSchema = z
  .object({
    schemaVersion: z.literal(OUTPUT_SCHEMA_VERSION),
    outputId: idSchema,
    events: z.array(reviewRecordSchema),
  })
  .strict();

export const attemptSchema = z
  .object({
    schemaVersion: z.literal(OUTPUT_SCHEMA_VERSION),
    attemptId: idSchema,
    workspaceId: idSchema,
    source: z
      .object({
        kind: z.enum(["normal-parent", "parallel-parent"]),
        runtimeId: z.string().min(1).max(256),
      })
      .strict(),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("new"), outputId: idSchema }).strict(),
      z
        .object({
          kind: z.literal("revision"),
          outputId: idSchema,
          expectedRevisionId: idSchema,
        })
        .strict(),
    ]),
    state: z.enum(["preparing", "saved", "conflict", "failed"]),
    createdAtMs: z.number().int().nonnegative(),
    receipt: z
      .object({
        outputId: idSchema,
        revisionId: idSchema,
        displayNumber: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OutputRecord = z.infer<typeof outputSchema>;
export type RevisionRecord = z.infer<typeof revisionSchema>;
export type AttemptRecord = z.infer<typeof attemptSchema>;
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export type ReviewsRecord = z.infer<typeof reviewsSchema>;
export type OutputFileRecord = z.infer<typeof outputFileSchema>;
