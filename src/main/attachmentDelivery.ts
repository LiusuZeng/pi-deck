import { AttachmentSelectionStore } from "./attachmentSelectionStore.js";

/**
 * Run the complete prompt/steer/follow-up delivery before consuming its opaque
 * selections. A rejected build or RPC leaves tokens intact for the renderer's
 * retry path.
 */
export async function deliverWithAttachmentConsumption<T>(options: {
  store: AttachmentSelectionStore;
  ownerId: string | undefined;
  selectedPathTokens: readonly string[];
  deliver(): Promise<T>;
}): Promise<T> {
  if (options.selectedPathTokens.length > 0 && options.ownerId === undefined) {
    throw new Error("Attachment owner generation is required for delivery.");
  }
  const result = await options.deliver();
  if (options.ownerId !== undefined && options.selectedPathTokens.length > 0) {
    options.store.consumeOwned(options.ownerId, options.selectedPathTokens);
  }
  return result;
}
