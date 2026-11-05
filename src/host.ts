// What differs between the two hosts omp-vcc runs on, omp (oh-my-pi) and Pi,
// beyond the functions each entry hands over (convertToLlm, the agent dir).
// Each comes from the host's own code: omp's from @oh-my-pi/pi-coding-agent,
// Pi's from @earendil-works/pi-coding-agent. index.ts binds omp, pi.ts binds Pi.
import { OMP_TRIGGER_RULE, PI_TRIGGER_RULE, type TriggerRule } from "./core/window";

export type HostName = "omp" | "pi";

export interface HostProfile {
  name: HostName;
  /** The host's name in what omp-vcc tells the user. */
  displayName: "omp" | "Pi";
  /** omp-vcc's command prefix: /omp-vcc… on omp; /pi-vcc… on Pi, the names pi-vcc users know. */
  command: "omp-vcc" | "pi-vcc";
  /** Where the host compacts, from the policy it hands the hook. */
  rule: TriggerRule;
  /**
   * The event after which the host will not continue on its own: omp's
   * agent_end without `willContinue`; Pi's agent_settled (its agent_end comes
   * before overflow recovery and queued work).
   */
  settledEvent: "agent_end" | "agent_settled";
  /** Where a user sets a model's contextWindow for the host. */
  modelsFile: string;
}

export const OMP_HOST: HostProfile = {
  name: "omp",
  displayName: "omp",
  command: "omp-vcc",
  rule: OMP_TRIGGER_RULE,
  settledEvent: "agent_end",
  modelsFile: "omp's models.yml",
};

export const PI_HOST: HostProfile = {
  name: "pi",
  displayName: "Pi",
  command: "pi-vcc",
  rule: PI_TRIGGER_RULE,
  settledEvent: "agent_settled",
  modelsFile: "Pi's models.json",
};
