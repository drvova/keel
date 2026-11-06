// Text a host put into a user message that the user did not write: omp's
// <system-reminder> blocks (Pi writes none). A message that held only that is
// left out; otherwise the block is cut and the user's words kept.
import type { NormalizedBlock } from "../types";

const HOST_BLOCK_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g;

export const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] =>
  blocks.flatMap((b): NormalizedBlock[] => {
    if (b.kind !== "user") return [b];
    const text = b.text.replace(HOST_BLOCK_RE, "").trim();
    // Keep sourceIndex: a clipped request names the #N that reads all of it.
    return text ? [{ ...b, text }] : [];
  });
