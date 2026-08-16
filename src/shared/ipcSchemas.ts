import { z } from "zod";

export const themePreferenceSchema = z.enum(["system", "light", "dark"]);

const appSettingsShape = {
  piBinaryPath: z.string().min(1).optional(),
  agentDir: z.string().min(1).optional(),
  sessionDir: z.string().min(1).optional(),
  images: z
    .object({
      blockImages: z.boolean().optional(),
      autoResize: z.boolean().optional(),
    })
    .strict()
    .optional(),
  projectCwd: z.string().min(1).optional(),
  theme: themePreferenceSchema,
  maxRunningSessions: z.number().int().min(1).max(20),
  warmWorkerLimit: z.number().int().min(0).max(20),
  enableLoginShellEnvCapture: z.boolean(),
} satisfies z.ZodRawShape;

export const appSettingsSchema = z
  .object({
    ...appSettingsShape,
    theme: appSettingsShape.theme.default("system"),
    maxRunningSessions: appSettingsShape.maxRunningSessions.default(4),
    warmWorkerLimit: appSettingsShape.warmWorkerLimit.default(1),
    enableLoginShellEnvCapture:
      appSettingsShape.enableLoginShellEnvCapture.default(true),
  })
  .strict();

export const appSettingsPatchSchema = z
  .object(appSettingsShape)
  .partial()
  .strict();

export const diagnosticsSummarySchema = z
  .object({
    appVersion: z.string(),
    userDataPath: z.string(),
    logPath: z.string(),
    settings: appSettingsSchema,
    recentErrors: z.array(z.string()),
  })
  .strict();

export const chatImageAttachmentSchema = z
  .object({
    id: z.string().optional(),
    fileName: z.string().optional(),
    mimeType: z.string(),
    dataBase64: z.string(),
  })
  .strict();

export const chatMessageSchema = z.preprocess(
  (value) => normalizeChatMessage(value),
  z
    .object({
      id: z.string().optional(),
      role: z.string(),
      content: z.string().optional(),
      imageAttachments: z.array(chatImageAttachmentSchema).optional(),
      createdAt: z.number().optional(),
    })
    .passthrough(),
);

function normalizeChatMessage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const content = extractTextContent(record.content);
  const imageAttachments = extractImageAttachments(record.content);
  return {
    ...record,
    ...(Array.isArray(record.content)
      ? { content: content ?? "" }
      : content !== undefined
        ? { content }
        : {}),
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
  };
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((item): string[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") {
      return [record.text];
    }
    return [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractImageAttachments(value: unknown): Array<{
  id?: string;
  fileName?: string;
  mimeType: string;
  dataBase64: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "image") {
      return [];
    }
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType : undefined;
    const dataBase64 =
      typeof record.data === "string"
        ? record.data
        : typeof record.dataBase64 === "string"
          ? record.dataBase64
          : undefined;
    if (mimeType === undefined || dataBase64 === undefined) {
      return [];
    }
    return [
      {
        id: typeof record.id === "string" ? record.id : `image-${index}`,
        ...(typeof record.fileName === "string"
          ? { fileName: record.fileName }
          : {}),
        mimeType,
        dataBase64,
      },
    ];
  });
}

export const chatStateSchema = z
  .object({
    runtimeId: z.string().optional(),
    sessionId: z.string().optional(),
    // Pi's production RPC state uses sessionName for its user-assigned
    // display name.
    sessionName: z.string().optional(),
    sessionFile: z.string().optional(),
    cwd: z.string().optional(),
    model: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    provider: z.string().optional(),
    thinkingLevel: z.string().optional(),
    isAgentActive: z.boolean().optional(),
  })
  .passthrough();

export const chatSnapshotRequestSchema = z
  .object({
    runtimeId: z.string().optional(),
  })
  .strict()
  .optional();

export const chatSnapshotSchema = z
  .object({
    runtimeId: z.string(),
    backendMode: z.enum(["fake", "real"]),
    workspaceId: z.string().min(1).optional(),
    // Pi reports cwd, while Pi Deck owns the project identifier. Keep both so
    // renderers never have to turn a filesystem path back into a project ID.
    projectId: z.string().optional(),
    state: chatStateSchema,
    messages: z.array(chatMessageSchema),
  })
  .strict();

// Deliberately small state projection for lifecycle recovery and post-turn
// metadata refreshes. Unlike ChatSnapshot, this DTO must never carry history.
export const chatRuntimeStatusRequestSchema = z
  .object({
    runtimeId: z.string().min(1),
  })
  .strict();

export const chatRuntimeUsageSchema = z
  .object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    contextUsedTokens: z.number().nonnegative().optional(),
    contextWindowTokens: z.number().nonnegative().optional(),
    totalCostUsd: z.number().nonnegative().optional(),
  })
  .strict();

const chatRuntimeStatusModelSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    provider: z.string().optional(),
    contextWindow: z.number().nonnegative().optional(),
  })
  .strict();

export const chatRuntimeStatusStateSchema = z
  .object({
    sessionId: z.string().optional(),
    sessionFile: z.string().optional(),
    cwd: z.string().optional(),
    model: z.union([z.string(), chatRuntimeStatusModelSchema]).optional(),
    provider: z.string().optional(),
    thinkingLevel: z.string().optional(),
    isAgentActive: z.boolean(),
  })
  .strict();

export const chatRuntimeStatusSchema = z
  .object({
    runtimeId: z.string(),
    backendMode: z.enum(["fake", "real"]),
    state: chatRuntimeStatusStateSchema,
    usage: chatRuntimeUsageSchema.optional(),
  })
  .strict();

export const chatSessionSummarySchema = z
  .object({
    id: z.string(),
    sessionFile: z.string(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    title: z.string(),
    updatedAtMs: z.number(),
    createdAtMs: z.number().optional(),
    messageCount: z.number().int().min(0),
    preview: z.string().optional(),
    attachedRuntimeId: z.string().optional(),
    archivedAtMs: z.number().optional(),
  })
  .strict();

export const bootstrapSessionSummarySchema = chatSessionSummarySchema.omit({
  attachedRuntimeId: true,
});

export const chatListSessionsRequestSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const chatListSessionsResultSchema = z
  .object({
    projectCwd: z.string(),
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().optional(),
    sessionDir: z.string().optional(),
    sessions: z.array(chatSessionSummarySchema),
    diagnostics: z.array(z.string()),
  })
  .strict();

export const chatResumeSessionRequestSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    sessionFile: z.string().min(1),
  })
  .strict();

export const chatDeleteSessionRequestSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    sessionFile: z.string().min(1),
  })
  .strict();

export const chatDeleteSessionResultSchema = z
  .object({
    deleted: z.literal(true),
    sessionFile: z.string(),
  })
  .strict();

export const chatDeleteAllSessionsRequestSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const chatDeleteAllSessionsResultSchema = z
  .object({
    deleted: z.literal(true),
    deletedCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
    // Counts alone cannot tell the renderer which composer owners are safe to
    // release when a bulk operation skips individual sessions.
    deletedSessionFiles: z.array(z.string()),
  })
  .strict();

export const chatModelSummarySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    provider: z.string().optional(),
    reasoning: z.boolean().optional(),
    thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
    input: z.array(z.string()).optional(),
    contextWindow: z.number().optional(),
  })
  .passthrough();

export const chatListModelsRequestSchema = z
  .object({
    runtimeId: z.string().optional(),
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .strict();

export const chatListModelsResultSchema = z
  .object({
    models: z.array(chatModelSummarySchema),
    activeModel: chatModelSummarySchema.optional(),
    thinkingLevel: z.string().optional(),
    thinkingLevels: z.array(z.string()),
  })
  .strict();

export const chatCommandSummarySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    source: z.enum(["extension", "prompt template", "skill"]).optional(),
    insertText: z.string().optional(),
  })
  .strict();

export const chatListCommandsRequestSchema = z
  .object({
    runtimeId: z.string(),
  })
  .strict();

export const chatListCommandsResultSchema = z
  .object({
    commands: z.array(chatCommandSummarySchema),
  })
  .strict();

export const chatSetModelRequestSchema = z
  .object({
    runtimeId: z.string(),
    provider: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict();

export const chatSetThinkingRequestSchema = z
  .object({
    runtimeId: z.string(),
    level: z.string().min(1),
  })
  .strict();

const attachmentTokenSchema = z.string().min(1).max(256);
// Owner IDs are one-use renderer generations. Session IDs are stable lifecycle
// identities used by trusted main-process teardown.
const attachmentOwnerIdSchema = z.string().min(1).max(1_024);
const attachmentSessionIdSchema = z.string().min(1).max(1_024);

export const chatPromptAttachmentSchema = z
  .object({
    selectedPathToken: attachmentTokenSchema,
    sendMode: z.enum(["imageInput", "pathReference"]),
  })
  .strict();

const chatPromptAttachmentsSchema = z
  .array(chatPromptAttachmentSchema)
  .max(100)
  .superRefine((attachments, context) => {
    const seen = new Set<string>();
    for (const [index, attachment] of attachments.entries()) {
      if (seen.has(attachment.selectedPathToken)) {
        context.addIssue({
          code: "custom",
          path: [index, "selectedPathToken"],
          message: "An attachment token may appear only once per request.",
        });
      }
      seen.add(attachment.selectedPathToken);
    }
  });

export const chatPromptRequestSchema = z
  .object({
    runtimeId: z.string(),
    text: z.string().trim().min(1),
    attachments: chatPromptAttachmentsSchema.optional(),
    attachmentOwnerId: attachmentOwnerIdSchema.optional(),
  })
  .strict();

export const chatInterventionRequestSchema = z
  .object({
    runtimeId: z.string(),
    text: z.string().trim().min(1),
    attachments: chatPromptAttachmentsSchema.optional(),
    attachmentOwnerId: attachmentOwnerIdSchema.optional(),
  })
  .strict();

export const chatAbortRequestSchema = z
  .object({
    runtimeId: z.string(),
  })
  .strict();

// Pi RPC extension_ui_response payloads. The runtime and request id stay
// outside this payload so main can scope a response to the worker that emitted
// the original request.
export const extensionUiResponsePayloadSchema = z.union([
  z.object({ confirmed: z.boolean() }).strict(),
  z.object({ value: z.string() }).strict(),
  z.object({ cancelled: z.literal(true) }).strict(),
]);

export const chatRespondToExtensionUiRequestSchema = z
  .object({
    runtimeId: z.string().min(1),
    requestId: z.string().min(1),
    response: extensionUiResponsePayloadSchema,
  })
  .strict();

/** Detach a runtime without deleting its persisted Pi session file. */
export const chatCloseSessionRequestSchema = z
  .object({
    runtimeId: z.string(),
  })
  .strict();

export const chatCreateSessionRequestSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const chatRuntimeEventSchema = z
  .object({
    type: z.string(),
    runtimeId: z.string(),
  })
  .passthrough();

export const projectRefSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    canonicalPath: z.string(),
    displayName: z.string(),
    lastOpenedAt: z.number(),
    invalidReason: z.string().optional(),
  })
  .strict();

export const pickProjectResultSchema = z.discriminatedUnion("selected", [
  z.object({ selected: z.literal(false) }).strict(),
  z.object({ selected: z.literal(true), project: projectRefSchema }).strict(),
]);

export const projectListResultSchema = z
  .object({
    activeProjectId: z.string().optional(),
    activeProject: projectRefSchema.optional(),
    projects: z.array(projectRefSchema),
  })
  .strict();

export const projectSelectRequestSchema = z
  .object({
    projectId: z.string().min(1),
  })
  .strict();

export const workspaceRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    isDefault: z.boolean().optional(),
    defaultProjectId: z.string().min(1).optional(),
    defaultProject: projectRefSchema.optional(),
    lastOpenedAt: z.number(),
  })
  .strict();

export const workspaceListResultSchema = z
  .object({
    activeWorkspaceId: z.string().min(1).optional(),
    activeWorkspace: workspaceRefSchema.optional(),
    workspaces: z.array(workspaceRefSchema),
    archivedWorkspaces: z.array(workspaceRefSchema).optional(),
  })
  .strict();

const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .transform((name) => name.replace(/\s+/g, " "));

export const workspaceCreateRequestSchema = z
  .object({
    name: workspaceNameSchema,
    defaultProjectId: z.string().min(1).optional(),
  })
  .strict();

export const workspaceUpdateRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    name: workspaceNameSchema.optional(),
    defaultProjectId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine(
    ({ name, defaultProjectId }) =>
      name !== undefined || defaultProjectId !== undefined,
    { message: "Workspace update must change at least one field." },
  );

export const workspaceSelectRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();

export const workspaceArchiveRequestSchema = workspaceSelectRequestSchema;
export const workspaceRestoreRequestSchema = workspaceSelectRequestSchema;

export const workspaceAddSessionRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionFile: z.string().min(1),
  })
  .strict();

export const workspaceMoveSessionRequestSchema = z
  .object({
    sessionFile: z.string().min(1),
    toWorkspaceId: z.string().min(1),
  })
  .strict();

export const workspaceRemoveSessionRequestSchema =
  workspaceAddSessionRequestSchema;
export const workspaceArchiveSessionRequestSchema =
  workspaceAddSessionRequestSchema;
export const workspaceRestoreSessionRequestSchema =
  workspaceAddSessionRequestSchema;

export const workspaceListSessionsRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    includeArchived: z.boolean().optional(),
  })
  .strict();

export const workspaceSessionMutationResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionFile: z.string().min(1),
  })
  .strict();

// Startup projection intentionally excludes runtime state and messages. It is
// assembled solely from local app/project metadata so rendering it can never
// create a Pi worker or trigger a session-repository scan.
export const appBootstrapStateSchema = z
  .object({
    backendMode: z.enum(["fake", "real"]),
    version: z.string(),
    settings: appSettingsSchema,
    diagnostics: diagnosticsSummarySchema,
    project: projectRefSchema,
    projects: z.array(projectRefSchema),
    // Optional for one compatibility release while older main processes only
    // expose directory-backed Projects.
    workspace: workspaceRefSchema.optional(),
    workspaces: z.array(workspaceRefSchema).optional(),
    archivedWorkspaces: z.array(workspaceRefSchema).optional(),
    cachedSessions: z.array(bootstrapSessionSummarySchema),
  })
  .strict();

// Renderer-only ownership used to revoke opaque attachment tokens when a
// draft/runtime is discarded. It is never a filesystem authority.
export const attachmentPickerRequestSchema = z
  .object({
    projectPath: z.string().optional(),
    workingDirectory: z.string().optional(),
    ownerId: attachmentOwnerIdSchema,
    sessionId: attachmentSessionIdSchema,
  })
  .strict();

export const attachmentDraftSchema = z
  .object({
    id: z.string(),
    selectedPathToken: attachmentTokenSchema,
    fileName: z.string(),
    displayPath: z.string(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    kind: z.enum(["image", "textFile", "binaryFile"]),
    sendMode: z.enum(["imageInput", "pathReference"]),
    outsideProject: z.boolean(),
    status: z.enum(["ready", "missing", "unreadable"]),
    warning: z.string().optional(),
    previewDataUrl: z.string().optional(),
  })
  .strict();

export const attachmentImportDroppedFilesRequestSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1).max(100),
    projectPath: z.string().optional(),
    workingDirectory: z.string().optional(),
    ownerId: attachmentOwnerIdSchema,
    sessionId: attachmentSessionIdSchema,
  })
  .strict();

export const attachmentImportImageRequestSchema = z
  .object({
    images: z
      .array(
        z
          .object({
            fileName: z.string().min(1).max(1_024),
            mimeType: z.string().min(1).max(256),
            size: z.number().int().nonnegative(),
            // Bound encoded input before it reaches the main process. The
            // exact decoded length and canonical base64 form are checked there.
            dataBase64: z.string().min(1).max(27_962_028),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    ownerId: attachmentOwnerIdSchema,
    sessionId: attachmentSessionIdSchema,
  })
  .strict();

export const attachmentReleaseRequestSchema = z
  .object({
    selectedPathTokens: z.array(attachmentTokenSchema).min(1).max(100),
    ownerId: attachmentOwnerIdSchema,
  })
  .strict();

export const attachmentReleaseOwnerRequestSchema = z
  .object({
    ownerId: attachmentOwnerIdSchema,
  })
  .strict();

export const attachmentAssignOwnerRequestSchema = z
  .object({
    selectedPathTokens: z.array(attachmentTokenSchema).min(1).max(100),
    previousOwnerId: attachmentOwnerIdSchema,
    previousSessionId: attachmentSessionIdSchema,
    ownerId: attachmentOwnerIdSchema,
    sessionId: attachmentSessionIdSchema,
  })
  .strict();

export const pickAttachmentsResultSchema = z.discriminatedUnion("selected", [
  z.object({ selected: z.literal(false) }).strict(),
  z
    .object({
      selected: z.literal(true),
      attachments: z.array(attachmentDraftSchema),
    })
    .strict(),
]);

// Multitask is scoped by a live parent runtime. The renderer can select only
// its currently attached parent; it cannot address or operate child sessions.
export const multitaskModeSchema = z.enum(["sequential", "parallel"]);
const multitaskRuntimeIdSchema = z.string().min(1);

export const multitaskModeRequestSchema = z
  .object({
    runtimeId: multitaskRuntimeIdSchema,
  })
  .strict();

export const multitaskModeUpdateRequestSchema = z
  .object({
    runtimeId: multitaskRuntimeIdSchema,
    mode: multitaskModeSchema,
  })
  .strict();

export const multitaskModeStateSchema = z
  .object({
    runtimeId: multitaskRuntimeIdSchema,
    mode: multitaskModeSchema,
  })
  .strict();

// Safe status-only projection. No child runtime/session, prompt, output, or
// controls are exposed to the renderer.
export const multitaskTaskSummarySchema = z
  .object({
    taskNumber: z.number().int().positive(),
    generatedName: z.string().min(1),
    status: z.enum([
      "queued",
      "running",
      "waiting-input",
      "completed",
      "failed",
    ]),
  })
  .strict();

export const multitaskStateEventSchema = multitaskModeStateSchema
  .extend({
    tasks: z.array(multitaskTaskSummarySchema),
  })
  .strict();

export const ipcErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    issues: z.unknown().optional(),
  })
  .strict();

export const apiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z.object({ ok: z.literal(false), error: ipcErrorSchema }).strict(),
  ]);

export const noPayloadSchema = z.undefined();

export const ipcChannels = {
  appGetVersion: "app:getVersion",
  appGetDiagnosticsSummary: "app:getDiagnosticsSummary",
  appGetBootstrapState: "app:getBootstrapState",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  chatGetSnapshot: "chat:getSnapshot",
  chatGetRuntimeStatus: "chat:getRuntimeStatus",
  chatListSessions: "chat:listSessions",
  chatResumeSession: "chat:resumeSession",
  chatDeleteSession: "chat:deleteSession",
  chatDeleteAllSessions: "chat:deleteAllSessions",
  chatPrompt: "chat:prompt",
  chatSteer: "chat:steer",
  chatFollowUp: "chat:followUp",
  chatAbort: "chat:abort",
  chatRespondToExtensionUi: "chat:respondToExtensionUi",
  chatCloseSession: "chat:closeSession",
  chatListModels: "chat:listModels",
  chatListCommands: "chat:listCommands",
  chatSetModel: "chat:setModel",
  chatSetThinking: "chat:setThinking",
  chatCreateSession: "chat:createSession",
  chatReset: "chat:reset",
  chatEvent: "chat:event",
  projectList: "projects:list",
  projectGetActive: "projects:getActive",
  projectSelect: "projects:select",
  projectPickFolder: "project:pickFolder",
  workspaceList: "workspaces:list",
  workspaceGetActive: "workspaces:getActive",
  workspaceCreate: "workspaces:create",
  workspaceUpdate: "workspaces:update",
  workspaceSelect: "workspaces:select",
  workspaceArchive: "workspaces:archive",
  workspaceRestore: "workspaces:restore",
  workspaceAddSession: "workspaces:addSession",
  workspaceMoveSession: "workspaces:moveSession",
  workspaceRemoveSession: "workspaces:removeSession",
  workspaceArchiveSession: "workspaces:archiveSession",
  workspaceRestoreSession: "workspaces:restoreSession",
  workspaceListSessions: "workspaces:listSessions",
  workspaceListUnassignedSessions: "workspaces:listUnassignedSessions",
  attachmentsPickFiles: "attachments:pickFiles",
  attachmentsImportDroppedFiles: "attachments:importDroppedFiles",
  attachmentsImportImages: "attachments:importImages",
  attachmentsRelease: "attachments:release",
  attachmentsReleaseOwner: "attachments:releaseOwner",
  attachmentsAssignOwner: "attachments:assignOwner",
  workflowGetTemplate: "workflows:getTemplate",
  workflowListWorkflows: "workflows:list",
  workflowCreateWorkflow: "workflows:create",
  workflowUpdateWorkflow: "workflows:update",
  workflowListTemplates: "workflows:listTemplates",
  workflowCreateTemplate: "workflows:createTemplate",
  workflowUpdateTemplate: "workflows:updateTemplate",
  workflowArchiveTemplate: "workflows:archiveTemplate",
  workflowDuplicateTemplate: "workflows:duplicateTemplate",
  workflowListRuns: "workflows:listRuns",
  workflowGetRun: "workflows:getRun",
  workflowStartRun: "workflows:startRun",
  workflowStopRun: "workflows:stopRun",
  workflowRetryStep: "workflows:retryStep",
  workflowRetryCondition: "workflows:retryCondition",
  workflowOverrideCondition: "workflows:overrideCondition",
  workflowApproveGate: "workflows:approveGate",
  workflowEvent: "workflows:event",
  canonicalWorkflowListRuns: "workflows:canonicalListRuns",
  canonicalWorkflowGetRun: "workflows:canonicalGetRun",
  canonicalWorkflowStartRun: "workflows:canonicalStartRun",
  canonicalWorkflowStopRun: "workflows:canonicalStopRun",
  canonicalWorkflowRetryOccurrence: "workflows:canonicalRetryOccurrence",
  canonicalWorkflowAnswerHuman: "workflows:canonicalAnswerHuman",
  canonicalWorkflowEvent: "workflows:canonicalEvent",
  workflowGraphGetSnapshot: "workflows:graphGetSnapshot",
  workflowGraphSubscribe: "workflows:graphSubscribe",
  workflowGraphUnsubscribe: "workflows:graphUnsubscribe",
  workflowGraphEvent: "workflows:graphEvent",
  multitaskGetMode: "multitask:getMode",
  multitaskUpdateMode: "multitask:updateMode",
  multitaskState: "multitask:state",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];
