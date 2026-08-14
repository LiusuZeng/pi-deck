import { z } from "zod";

/** Version of the local extension-to-host delegation protocol. */
export const DELEGATION_BRIDGE_PROTOCOL_VERSION = 1 as const;

const protocolEnvelope = {
  version: z.literal(DELEGATION_BRIDGE_PROTOCOL_VERSION),
};

/** A caller-provided tool call identity, scoped to one socket connection. */
export const toolCallIdSchema = z.string().min(1).max(256);

/** The only message accepted before a connection is authenticated. */
export const authenticateMessageSchema = z
  .object({
    ...protocolEnvelope,
    type: z.literal("authenticate"),
    token: z.string().length(64),
  })
  .strict();

/**
 * The bridge intentionally treats payload as opaque JSON.  It does not parse
 * prompts or interpret extension tool arguments.
 */
export const delegateMessageSchema = z
  .object({
    ...protocolEnvelope,
    type: z.literal("delegate"),
    toolCallId: toolCallIdSchema,
    payload: z.unknown(),
  })
  .strict();

/** Request the current delegation mode for the authenticated parent capability. */
export const modeQueryMessageSchema = z
  .object({
    ...protocolEnvelope,
    type: z.literal("mode-query"),
    requestId: toolCallIdSchema,
  })
  .strict();

export const inputResponseMessageSchema = z
  .object({
    ...protocolEnvelope,
    type: z.literal("child-input-response"),
    toolCallId: toolCallIdSchema,
    input: z.string().min(1).max(32_768),
  })
  .strict();

export const clientMessageSchema = z.union([
  authenticateMessageSchema,
  delegateMessageSchema,
  modeQueryMessageSchema,
  inputResponseMessageSchema,
]);

const childMessage = {
  ...protocolEnvelope,
  toolCallId: toolCallIdSchema,
};

/** Safe progress state only; it deliberately has no child session identifier. */
export const childLifecycleMessageSchema = z
  .object({
    ...childMessage,
    type: z.literal("child-lifecycle"),
    // Public task numbers are stable routing keys, never child runtime IDs.
    // Optional for v1 bridge compatibility; production waiting-input events set it.
    taskNumber: z.number().int().positive().optional(),
    status: z.enum([
      "queued",
      "running",
      "waiting-input",
      "completed",
      "failed",
      "cancelled",
    ]),
  })
  .strict();

/** A terminal handoff is the only result data exposed to the parent extension. */
export const childResultMessageSchema = z
  .object({
    ...childMessage,
    type: z.literal("child-result"),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    handoff: z
      .object({
        summary: z.string().max(32_768).optional(),
        details: z.string().max(32_768).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const childInputNeededMessageSchema = z
  .object({
    ...childMessage,
    type: z.literal("child-input-needed"),
    message: z.string().min(1).max(32_768),
  })
  .strict();

export const authenticatedMessageSchema = z
  .object({ ...protocolEnvelope, type: z.literal("authenticated") })
  .strict();

/** Authoritative response to a mode query; never supplied by the extension. */
export const modeStateMessageSchema = z
  .object({
    ...protocolEnvelope,
    type: z.literal("mode-state"),
    requestId: toolCallIdSchema,
    mode: z.enum(["sequential", "parallel"]),
  })
  .strict();

export type DelegateWireMessage = z.infer<typeof delegateMessageSchema>;
export type ModeQueryWireMessage = z.infer<typeof modeQueryMessageSchema>;
export type ModeStateWireMessage = z.infer<typeof modeStateMessageSchema>;
export type ChildInputResponseWireMessage = z.infer<
  typeof inputResponseMessageSchema
>;
export type ChildLifecycleStatus = z.infer<
  typeof childLifecycleMessageSchema
>["status"];
export type ChildLifecycleWireMessage = z.infer<
  typeof childLifecycleMessageSchema
>;
export type ChildResultWireMessage = z.infer<typeof childResultMessageSchema>;
export type ChildInputNeededWireMessage = z.infer<
  typeof childInputNeededMessageSchema
>;
