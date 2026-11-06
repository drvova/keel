import type { Message } from "@oh-my-pi/pi-ai";

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** User text an extension sent on the agent's behalf (omp `attribution: "agent"`), not words the user wrote. */
export const isExtensionUserMessage = (m: unknown): boolean => isObject(m) && m.role === "user" && m.attribution === "agent";

/**
 * A message as recall and the summary can read it. Session files can hold what
 * no renderer expects (a null content part, tool-call arguments that are not an
 * object, content that is neither text nor parts); one such entry threw out of
 * search and took every vcc_recall query down with it, and out of normalize and
 * the compaction with it. Shapes without `content` (a `!cmd`, a python cell)
 * pass through untouched.
 */
export const readableMessage = (message: Record<string, unknown>): Message => {
  const content = message.content;
  if (content === undefined || typeof content === "string") return message as unknown as Message;
  if (!Array.isArray(content)) return { ...message, content: "" } as unknown as Message;
  const parts = content.filter(isObject).map((part) => {
    if (part.type === "toolCall") {
      return {
        ...part,
        name: typeof part.name === "string" ? part.name : "unknown",
        arguments: isObject(part.arguments) ? part.arguments : {},
      };
    }
    if (part.type === "text" && typeof part.text !== "string") return { ...part, text: "" };
    return part;
  });
  return { ...message, content: parts } as unknown as Message;
};

export const clip = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
};

export const textParts = (content: Message["content"]): string[] => {
  if (!content) return [];
  if (typeof content === "string") return [content];
  return (content as Array<{ type?: string; text?: unknown }>)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
};

export const textOf = (content: Message["content"]): string =>
  textParts(content).join("\n");
