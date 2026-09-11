export interface ChatSnapshotReader<State, Message> {
  getState(runtimeId: string): Promise<State>;
  getMessages(runtimeId: string): Promise<Message[]>;
}

export interface ChatSnapshotReadOptions {
  skipMessages?: boolean;
}

/**
 * Fetch the independent Pi snapshot inputs concurrently. Resume correctness
 * (canonical file/workspace ownership) is established before this helper is
 * called; this only removes avoidable RPC serialization from first paint.
 */
export async function readChatSnapshotInputs<State, Message>(
  reader: ChatSnapshotReader<State, Message>,
  runtimeId: string,
  options: ChatSnapshotReadOptions = {},
): Promise<{ state: State; messages: Message[] }> {
  if (options.skipMessages === true) {
    return { state: await reader.getState(runtimeId), messages: [] };
  }

  const [state, messages] = await Promise.all([
    reader.getState(runtimeId),
    reader.getMessages(runtimeId),
  ]);
  return { state, messages };
}
