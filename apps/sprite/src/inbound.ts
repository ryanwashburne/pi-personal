export type InboundMessage = {
  messageHandle: string;
  fromNumber: string;
  content: string;
  mediaUrl?: string;
};

export function parseInbound(body: unknown): InboundMessage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const payload = body as Record<string, unknown>;
  if (payload.is_outbound === true) return undefined;

  const fromNumber = firstString(payload.from_number, payload.number);
  const messageHandle = firstString(payload.message_handle);
  if (!fromNumber || !messageHandle) return undefined;

  const content = firstString(payload.content) ?? "";
  const mediaUrl = firstString(payload.media_url);
  if (!content && !mediaUrl) return undefined;

  return {
    messageHandle,
    fromNumber,
    content,
    mediaUrl: mediaUrl || undefined,
  };
}

export function promptFromInbound(message: InboundMessage): string {
  if (message.content && message.mediaUrl) {
    return `${message.content}\n\n[attached media: ${message.mediaUrl}]`;
  }
  if (message.mediaUrl) {
    return `[attached media: ${message.mediaUrl}]`;
  }
  return message.content;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
