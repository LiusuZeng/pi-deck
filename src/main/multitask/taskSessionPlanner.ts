export interface TaskSessionPlannerTask {
  generatedName: string;
  brief: string;
}

export interface TaskSessionPlannerPlan {
  contextSummary: string;
  tasks: TaskSessionPlannerTask[];
}

export const TASK_SESSION_PLANNER_MAX_TASKS = 20;
const MAX_CONTEXT = 12_000;
const MAX_NAME = 96;
const MAX_BRIEF = 512;
const MAX_RESPONSE = 64_000;
export const TASK_SESSION_PLANNER_TIMEOUT_MS = 120_000;

/** Uses a bounded positive integer so a bad environment value cannot disable cleanup. */
export function resolveTaskSessionPlannerTimeoutMs(
  value = process.env.PI_DECK_TASK_SESSION_PLANNER_TIMEOUT_MS,
): number {
  if (value === undefined || value.trim() === "")
    return TASK_SESSION_PLANNER_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : TASK_SESSION_PLANNER_TIMEOUT_MS;
}

export function buildTaskSessionPlannerPrompt(input: {
  originalPrompt: string;
  parentContext: string;
}): string {
  return `You are a private planning worker. Decompose the user's request into independently executable implementation tasks. You are not a chat assistant and must not execute the work. Return ONLY strict JSON, with no markdown or commentary, in exactly this shape:
{"contextSummary":"...","tasks":[{"generatedName":"...","brief":"..."}]}

Rules:
- Produce 1 to ${TASK_SESSION_PLANNER_MAX_TASKS} tasks. Use intelligent fanout when work is naturally separable (for example, a request comparing three countries should normally produce three country tasks).
- Each task must be independently executable by a private worker and include enough concrete scope to avoid overlap.
- generatedName and brief must each be one line. Keep names concise and briefs actionable.
- contextSummary is a concise, safe summary of relevant parent context, not a transcript.

Original request:
${boundedText(input.originalPrompt, MAX_CONTEXT)}

Relevant parent context:
${boundedText(input.parentContext, MAX_CONTEXT)}`;
}

/** Extracts a plain or fenced JSON object and enforces the planner contract. */
export function parseTaskSessionPlannerResponse(
  response: string,
): TaskSessionPlannerPlan {
  if (typeof response !== "string" || response.length > MAX_RESPONSE) {
    throw new Error("Planner response is too large.");
  }
  const text = response.trim();
  let parsed: unknown;
  try {
    // Prefer an exact response, including a top-level object with trailing braces
    // inside quoted strings, before looking for an object in model prose.
    parsed = JSON.parse(text);
  } catch {
    parsed = JSON.parse(extractJsonObject(text));
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.contextSummary !== "string" ||
    !Array.isArray(parsed.tasks)
  ) {
    throw new Error("Planner response is not a task-session plan.");
  }
  const contextSummary = boundedText(parsed.contextSummary, MAX_CONTEXT).trim();
  if (!contextSummary)
    throw new Error("Planner response has no context summary.");
  if (
    parsed.tasks.length < 1 ||
    parsed.tasks.length > TASK_SESSION_PLANNER_MAX_TASKS
  ) {
    throw new Error("Planner response has an invalid task count.");
  }
  const tasks = parsed.tasks.map((task) => {
    if (
      !isRecord(task) ||
      typeof task.generatedName !== "string" ||
      typeof task.brief !== "string"
    ) {
      throw new Error("Planner response contains an invalid task.");
    }
    const generatedName = oneLine(task.generatedName, MAX_NAME);
    const brief = oneLine(task.brief, MAX_BRIEF);
    if (!generatedName || !brief)
      throw new Error("Planner response contains an empty task.");
    return { generatedName, brief };
  });
  return { contextSummary, tasks };
}

export function boundedParentContext(
  messages: readonly { role: string; content?: unknown }[],
): string {
  const context = messages
    .slice(-8)
    .map(
      (message) =>
        `${message.role}: ${typeof message.content === "string" ? message.content : ""}`,
    )
    .join("\n");
  return boundedText(context, MAX_CONTEXT).trim() || "No prior parent context.";
}

export function fallbackTaskSessionPlan(
  originalPrompt: string,
  parentContext: string,
): TaskSessionPlannerPlan {
  return {
    contextSummary:
      boundedText(parentContext, 2_000).trim() || "No prior parent context.",
    tasks: [
      {
        generatedName:
          oneLine(originalPrompt, MAX_NAME) || "Complete requested work",
        brief:
          "Independently complete the requested work, verify it, and report a concise result.",
      },
    ],
  };
}

function extractJsonObject(value: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced?.trim() || text;
  const start = candidate.indexOf("{");
  if (start < 0) throw new Error("Planner response contains no JSON object.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0)
      return candidate.slice(start, index + 1);
  }
  throw new Error("Planner response contains incomplete JSON.");
}

function oneLine(value: string, max: number): string {
  return boundedText(value, max)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedText(value: string, max: number): string {
  return typeof value === "string"
    ? value.replace(/\u0000/g, "").slice(0, max)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
