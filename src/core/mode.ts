export const agentModes = ["hosting-node", "monitor-only"] as const;

export type AgentMode = (typeof agentModes)[number];

export function agentRunsCommands(mode: AgentMode) {
  return mode === "hosting-node";
}
