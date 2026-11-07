// What omp-vcc's TypeScript side reads of a message itself (the core reads the rest).
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** User text an extension sent on the agent's behalf (omp `attribution: "agent"`), not words the user wrote. */
export const isExtensionUserMessage = (m: unknown): boolean => isObject(m) && m.role === "user" && m.attribution === "agent";
