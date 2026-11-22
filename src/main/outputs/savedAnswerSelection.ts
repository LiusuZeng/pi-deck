export interface SavedAnswerMessage {
  id?: string | undefined;
  role: string;
  content?: string | undefined;
}

export function selectCompletedAssistantAnswer(input: {
  isAgentActive: boolean;
  messages: readonly SavedAnswerMessage[];
  assistantText: string;
  assistantMessageId?: string;
}): string {
  if (input.isAgentActive) {
    throw new Error(
      "Wait for the assistant answer to finish before saving it.",
    );
  }
  const candidates = input.messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    const content = stripSavedAnswerTransportMarker(message.content ?? "");
    if (content.trim().length === 0) return [];
    return [{ id: message.id?.trim(), content }];
  });
  const selected =
    input.assistantMessageId === undefined
      ? [...candidates]
          .reverse()
          .find((candidate) => candidate.content === input.assistantText)
      : candidates.find(
          (candidate) =>
            candidate.id === input.assistantMessageId &&
            candidate.content === input.assistantText,
        );
  if (selected === undefined) {
    throw new Error(
      "This assistant answer is no longer present in the attached session.",
    );
  }
  return selected.content;
}

export function stripSavedAnswerTransportMarker(content: string): string {
  return content.replace(
    /^<!-- pi-deck-synthesis-delivery:v1:[^\s]+ -->\n?/,
    "",
  );
}
