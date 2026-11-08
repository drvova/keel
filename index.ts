// keel: algorithmic compaction and recall for omp (oh-my-pi) (package.json
// "omp.extensions"). omp binds this factory once per session, subagents
// included.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { register } from "./src/register";
import { ompHost } from "./src/host";

export default (pi: ExtensionAPI) => register(pi, ompHost(pi));
