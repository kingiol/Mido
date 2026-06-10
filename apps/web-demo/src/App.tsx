import { useEffect, useMemo, useState } from "react";

import {
  createAgentClient,
  createAgentSkillManager,
  createBrowserSseTransport,
  registerManagedMcpHttpClientTools,
  useAgentRun,
  usePendingInteractiveTools,
  useToolCalls,
} from "@mido/client-web";
import type { ClientSkillStore, ClientSkillSummary } from "@mido/client-web";
import { buildRunTrace, type AgentMessage } from "@mido/protocol-core";

import { exportEventsAsJsonl } from "./export-jsonl.js";
import { DEMO_CLIENT_SYSTEM_PROMPT } from "../prompts.js";

const transport = createBrowserSseTransport({
  runUrl: "/api/run",
  resumeUrl: "/api/resume",
  cancelUrl: "/api/cancel",
});

type RemoteMcpStatus =
  | { state: "loading" }
  | { state: "connected"; toolCount: number }
  | { state: "failed"; reason: string };

type SkillCatalogStatus = "loading" | "ready" | "failed";

class DemoSkillStore implements ClientSkillStore {
  private readonly skills = new Map<string, ClientSkillSummary>();

  async listSkills(): Promise<ClientSkillSummary[]> {
    return [...this.skills.values()];
  }

  async saveSkill(skill: ClientSkillSummary): Promise<ClientSkillSummary> {
    this.skills.set(skill.id, skill);
    return skill;
  }

  async deleteSkill(skillId: string): Promise<void> {
    this.skills.delete(skillId);
  }
}

const demoSkillManager = createAgentSkillManager({
  store: new DemoSkillStore(),
});
const demoClient = createAgentClient({
  transport,
  systemPrompt: DEMO_CLIENT_SYSTEM_PROMPT,
  skillManager: demoSkillManager,
});
const tencentMapMcpRegistration = registerTencentMapMcpTools();

demoClient.registerClientTool({
  name: "getLocation",
  description: "Read the current client-side mock location.",
  executionPolicy: "client_auto",
  inputSchema: {
    type: "object",
    additionalProperties: false,
  },
  resultSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      city: { type: "string" },
      source: { type: "string" },
    },
    required: ["city", "source"],
  },
  execute: async () => ({
    city: "Hangzhou",
    source: "demo-web-client",
  }),
});

demoClient.registerClientTool({
  name: "confirmAction",
  description: "Ask the user to confirm a local destructive action.",
  executionPolicy: "client_interactive",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: {
        type: "string",
        description: "Confirmation message to show for the local destructive action.",
      },
    },
    required: ["message"],
  },
  resultSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      approved: { type: "boolean" },
      ret: { type: "string" },
    },
    required: ["approved", "ret"],
  },
  execute: async () => ({
    approved: true,
    ret: "I Have all deleted the draft successfully.",
  }),
});

const quickPrompts = [
  {
    group: "Core Tools",
    label: "Server Tool",
    prompt: "weather in shanghai",
  },
  {
    group: "Core Tools",
    label: "Client Auto Tool",
    prompt: "weather here",
  },
  {
    group: "Core Tools",
    label: "Interactive Tool",
    prompt: "delete draft",
  },
  {
    group: "Toolkit Tools",
    label: "Toolkit Workspace",
    prompt:
      "Use server__workspace_search to find agent-capability-roadmap.md, then summarize the toolkit section.",
  },
  {
    group: "Toolkit Tools",
    label: "Toolkit Search",
    prompt: "Use server__search_web to search for Mido agent SDK and summarize the top results.",
  },
  {
    group: "Toolkit Tools",
    label: "Toolkit File Read",
    prompt:
      "Use server__workspace_read_file to read package.json and tell me the project name.",
  },
  {
    group: "Toolkit Tools",
    label: "Toolkit Memory",
    prompt:
      "Use server__memory_write to remember that the demo favorite color is teal in scope demo, then use server__memory_search to find it.",
  },
  {
    group: "Toolkit Tools",
    label: "Toolkit Fetch",
    prompt: "Use server__fetch_url to fetch https://example.com and summarize the page.",
  },
  {
    group: "Agent Workflows",
    label: "Single Agent",
    prompt:
      "Use demoResearchAgent to inspect the Mido server-sdk multi-agent implementation, then summarize what the child agent found.",
  },
  {
    group: "Agent Workflows",
    label: "Multi Agent",
    prompt:
      "Use runAgentWorkflow to create a workflow with two parallel research agents and one writer agent that depends on both research agents. The first research agent should inspect server multi-agent code, the second should inspect the workflow design doc, and the writer should synthesize the results.",
  },
] as const;

const quickPromptGroups = quickPrompts.reduce<
  Array<{
    title: (typeof quickPrompts)[number]["group"];
    prompts: Array<(typeof quickPrompts)[number]>;
  }>
>((groups, prompt) => {
  const group = groups.find((item) => item.title === prompt.group);
  if (group) {
    group.prompts.push(prompt);
  } else {
    groups.push({ title: prompt.group, prompts: [prompt] });
  }

  return groups;
}, []);

interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function App() {
  const [input, setInput] = useState("weather in shanghai");
  const [providerLabel, setProviderLabel] = useState("loading...");
  const [reasoningLabel, setReasoningLabel] = useState("loading...");
  const [toolkitLabel, setToolkitLabel] = useState("loading...");
  const [skillCatalogStatus, setSkillCatalogStatus] =
    useState<SkillCatalogStatus>("loading");
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skills, setSkills] = useState<ClientSkillSummary[]>([]);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const snapshot = useAgentRun(demoClient);
  const toolCalls = useToolCalls(demoClient);
  const pendingInteractiveTools = usePendingInteractiveTools(demoClient);
  const runTrace = useMemo(
    () => buildRunTrace(snapshot.events),
    [snapshot.events],
  );
  const busy =
    snapshot.status === "running" || snapshot.status === "awaiting_client_tool";
  const chatTurns = toChatTurns(snapshot.conversationMessages);
  const canRetry =
    !busy &&
    (snapshot.status === "error" || snapshot.status === "cancelled") &&
    chatTurns.some((turn) => turn.role === "user");

  const exportTimeline = async () => {
    const result = await exportEventsAsJsonl(snapshot.events);
    if (result.status === "saved") {
      if (result.method === "share") {
        setExportFeedback(
          `Shared ${snapshot.events.length} events as ${result.filename}`,
        );
      } else {
        setExportFeedback(
          `Saved ${snapshot.events.length} events as ${result.filename}`,
        );
      }
      return;
    }

    if (result.status === "cancelled") {
      setExportFeedback("Save cancelled");
      return;
    }

    setExportFeedback(result.message);
  };

  useEffect(() => {
    let cancelled = false;

    tencentMapMcpRegistration.then((result) => {
      if (!cancelled) {
        console.log(`Tencent Map MCP: ${result.state}`);
      }
    });

    fetch("/api/health")
      .then(async (response) => response.json())
      .then((payload) => {
        if (cancelled) {
          return;
        }

        const provider =
          typeof payload.provider === "string" ? payload.provider : "unknown";
        const model =
          typeof payload.model === "string" ? payload.model : "unknown";
        setProviderLabel(`${provider} / ${model}`);
        setReasoningLabel(
          payload.exposeReasoningEvents === true ? "visible" : "hidden",
        );
        setToolkitLabel(formatToolkitLabel(payload.toolkit));
      })
      .catch(() => {
        if (!cancelled) {
          setProviderLabel("unavailable");
          setReasoningLabel("unavailable");
          setToolkitLabel("unavailable");
        }
      });

    fetch("/api/skills")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Skill catalog returned ${response.status}`);
        }
        return response.json();
      })
      .then(async (payload) => {
        const remoteSkills = readDemoSkills(payload);
        const installed = await demoSkillManager.listSkills();
        const installedById = new Map(
          installed.map((skill) => [skill.id, skill]),
        );

        for (const skill of remoteSkills) {
          await demoSkillManager.installSkill({
            ...skill,
            enabled: installedById.get(skill.id)?.enabled ?? skill.enabled,
          });
        }

        if (!cancelled) {
          setSkills(await demoSkillManager.listSkills());
          setSkillCatalogStatus("ready");
          setSkillError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSkillCatalogStatus("failed");
          setSkillError(error instanceof Error ? error.message : "unknown");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const submitPrompt = async (prompt: string) => {
    const text = prompt.trim();
    if (!text) {
      return;
    }

    setInput("");

    try {
      await snapshot.sendMessage(text);
    } catch (error) {
      console.error(error);
    }
  };

  const approveInteractiveTool = async (toolCallId: string) => {
    try {
      await snapshot.approveToolCall(toolCallId);
    } catch (error) {
      console.error(error);
    }
  };

  const rejectInteractiveTool = async (toolCallId: string) => {
    try {
      await snapshot.rejectToolCall(toolCallId);
    } catch (error) {
      console.error(error);
    }
  };

  const cancelRun = async () => {
    try {
      await snapshot.cancelRun("Cancelled from the web demo");
    } catch (error) {
      console.error(error);
    }
  };

  const retryRun = async () => {
    try {
      await snapshot.retryLastRun();
    } catch (error) {
      console.error(error);
    }
  };

  const resetConversation = () => {
    snapshot.clearConversation();
    setInput("weather in shanghai");
  };

  const toggleSkill = async (skillId: string) => {
    const skill = skills.find((item) => item.id === skillId);
    if (!skill) {
      return;
    }

    await demoSkillManager.setSkillEnabled(skillId, !skill.enabled);
    setSkills(await demoSkillManager.listSkills());
  };

  const runSkillProbe = async (skillId: string) => {
    const installed = await demoSkillManager.listSkills();
    for (const skill of installed) {
      await demoSkillManager.setSkillEnabled(skill.id, skill.id === skillId);
    }

    setSkills(await demoSkillManager.listSkills());
    await submitPrompt(getSkillProbePrompt(skillId));
  };

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Mido local test environment</p>
        <h1>Web client + API server demo</h1>
        <p className="lede">
          This demo runs the agent loop on the server, streams events over SSE,
          auto-executes local client tools, and pauses for interactive
          confirmation when needed.
        </p>
      </section>

      <section className="layout">
        <article className="panel controls">
          <header className="panel-header">
            <div>
              <h2>Scenarios</h2>
              <p>Use a preset or type your own message.</p>
            </div>
            <span className={`status status-${snapshot.status}`}>
              {snapshot.status}
            </span>
          </header>

          <div className="prompt-group-list">
            {quickPromptGroups.map((group) => (
              <section className="prompt-group" key={group.title}>
                <h3>{group.title}</h3>
                <div className="prompt-grid">
                  {group.prompts.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="ghost-button"
                      onClick={() => submitPrompt(item.prompt)}
                      disabled={busy}
                    >
                      <strong>{item.label}</strong>
                      <span>{item.prompt}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="skill-panel">
            <header className="skill-panel-header">
              <div>
                <h3>Skill Tests</h3>
                <span>{formatSkillLabel(skillCatalogStatus, skills)}</span>
              </div>
              {skillCatalogStatus === "failed" ? (
                <span className="pill pill-error">failed</span>
              ) : null}
            </header>

            <div className="skill-list">
              {skillCatalogStatus === "loading" ? (
                <p className="empty">Loading skills...</p>
              ) : null}
              {skillCatalogStatus === "failed" ? (
                <p className="empty">{skillError ?? "Skill catalog failed"}</p>
              ) : null}
              {skillCatalogStatus === "ready" && skills.length === 0 ? (
                <p className="empty">No skills available.</p>
              ) : null}
              {skills.map((skill) => (
                <div key={skill.id} className="skill-row">
                  <div>
                    <strong>{skill.name}</strong>
                    <span>{skill.id}</span>
                  </div>
                  <button
                    type="button"
                    className={`skill-toggle${
                      skill.enabled ? " skill-toggle-enabled" : ""
                    }`}
                    aria-pressed={skill.enabled}
                    onClick={() => toggleSkill(skill.id)}
                    disabled={busy}
                  >
                    {skill.enabled ? "On" : "Off"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button skill-probe-button"
                    onClick={() => runSkillProbe(skill.id)}
                    disabled={busy || skill.status !== "ready"}
                  >
                    Probe
                  </button>
                </div>
              ))}
            </div>
          </div>

          <form
            className="composer"
            onSubmit={async (event) => {
              event.preventDefault();
              await submitPrompt(input);
            }}
          >
            <label htmlFor="prompt">Message</label>
            <textarea
              id="prompt"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={4}
            />
            <div className="composer-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !input.trim()}
              >
                Send
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={cancelRun}
                disabled={!busy}
              >
                Stop
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={retryRun}
                disabled={!canRetry}
              >
                Retry
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={resetConversation}
                disabled={busy || chatTurns.length === 0}
              >
                New Chat
              </button>
            </div>
          </form>

          <div className="info-box">
            <div>
              Mock client location: <strong>Hangzhou</strong>
            </div>
            <div>
              Provider: <strong>{providerLabel}</strong>
            </div>
            <div>
              Reasoning events: <strong>{reasoningLabel}</strong>
            </div>
            <div>
              Toolkit core: <strong>{toolkitLabel}</strong>
            </div>
            <div>
              Skills:{" "}
              <strong>{formatSkillLabel(skillCatalogStatus, skills)}</strong>
            </div>
            <div>
              API health: <code>GET /api/health</code>
            </div>
          </div>

          {pendingInteractiveTools.length > 0 ? (
            <div className="pending-stack">
              {pendingInteractiveTools.map((toolCall) => {
                const message =
                  typeof toolCall.args.message === "string"
                    ? toolCall.args.message
                    : "Confirm this action?";
                return (
                  <article key={toolCall.toolCallId} className="pending-card">
                    <header>
                      <span className="pill">Interactive Tool</span>
                      <strong>{toolCall.toolName}</strong>
                    </header>
                    <p>{message}</p>
                    <div className="action-row">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() =>
                          approveInteractiveTool(toolCall.toolCallId)
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          rejectInteractiveTool(toolCall.toolCallId)
                        }
                      >
                        Reject
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </article>

        <article className="panel transcript">
          <header className="panel-header">
            <div>
              <h2>Conversation</h2>
              <p>
                Messages in this browser session are sent as the next run
                context.
              </p>
            </div>
          </header>
          <div className="conversation-list">
            {chatTurns.length === 0 ? (
              <p className="empty">No messages yet.</p>
            ) : null}
            {chatTurns.map((turn) => (
              <article
                key={turn.id}
                className={`chat-turn chat-turn-${turn.role}`}
              >
                <span>{turn.role}</span>
                <p>{turn.text}</p>
              </article>
            ))}
            {busy && pendingInteractiveTools.length === 0 ? (
              <article className="chat-turn chat-turn-assistant chat-turn-pending">
                <span>assistant</span>
                <p>{snapshot.textTranscript || "Running..."}</p>
              </article>
            ) : null}
          </div>

          {snapshot.error ? (
            <div className="error-box">
              <strong>{snapshot.error.code}</strong>
              <span>{snapshot.error.message}</span>
            </div>
          ) : null}
        </article>

        <article className="panel timeline">
          <header className="panel-header">
            <div>
              <h2>Run Inspector</h2>
              <p>Trace summary, spans, errors, and raw `CoreEvent` JSONL.</p>
              {exportFeedback ? (
                <p className="export-feedback">{exportFeedback}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="secondary-button export-button"
              onClick={exportTimeline}
              disabled={snapshot.events.length === 0}
              aria-label="Export event timeline as JSONL"
              title="Export JSONL"
            >
              <ExportIcon />
            </button>
          </header>

          <div className="trace-summary-grid">
            <div className="trace-stat">
              <span>Status</span>
              <strong>{runTrace.status}</strong>
            </div>
            <div className="trace-stat">
              <span>Duration</span>
              <strong>{formatDuration(runTrace.durationMs)}</strong>
            </div>
            <div className="trace-stat">
              <span>Events</span>
              <strong>{runTrace.eventCount}</strong>
            </div>
            <div className="trace-stat">
              <span>Usage</span>
              <strong>{formatUsage(runTrace.modelCalls)}</strong>
            </div>
          </div>

          <div className="span-summary">
            <h3>Spans</h3>
            {runTrace.modelCalls.length === 0 &&
            runTrace.toolCalls.length === 0 ? (
              <p className="empty">No spans yet.</p>
            ) : null}
            {runTrace.modelCalls.map((modelCall) => (
              <div key={modelCall.modelCallId} className="span-row">
                <div>
                  <span className="span-kind">model</span>
                  <strong>
                    {modelCall.model ?? modelCall.provider ?? "model call"}
                  </strong>
                  {modelCall.providerRequestId ? (
                    <small>{modelCall.providerRequestId}</small>
                  ) : null}
                </div>
                <span className={`pill pill-${modelCall.status}`}>
                  {modelCall.status}
                </span>
                <span>{formatDuration(modelCall.durationMs)}</span>
              </div>
            ))}
            {runTrace.toolCalls.map((toolCall) => (
              <div key={toolCall.toolCallId} className="span-row">
                <div>
                  <span className="span-kind">tool</span>
                  <strong>{toolCall.toolName ?? toolCall.toolCallId}</strong>
                  {toolCall.executionPolicy ? (
                    <small>{toolCall.executionPolicy}</small>
                  ) : null}
                </div>
                <span className={`pill pill-${toolCall.status}`}>
                  {toolCall.status}
                </span>
                <span>{formatDuration(toolCall.durationMs)}</span>
              </div>
            ))}
          </div>

          <div className="error-summary">
            <h3>Errors</h3>
            {runTrace.errors.length === 0 ? (
              <p className="empty">No errors.</p>
            ) : null}
            {runTrace.errors.map((error) => (
              <div key={error.eventId} className="error-row">
                <strong>{error.code ?? "error"}</strong>
                <span>{error.message ?? `Event #${error.sequence}`}</span>
              </div>
            ))}
          </div>

          <div className="timeline-list">
            {snapshot.events.length === 0 ? (
              <p className="empty">Start a run to see streamed events.</p>
            ) : null}
            {snapshot.events.map((event) => (
              <div key={event.eventId} className="timeline-item">
                <div className="timeline-meta">
                  <span>{event.type}</span>
                  <span>#{event.sequence}</span>
                </div>
                <pre>{JSON.stringify(event, null, 2)}</pre>
              </div>
            ))}
          </div>

          <div className="tool-summary">
            <h3>Local Tool State</h3>
            {toolCalls.length === 0 ? (
              <p className="empty">No tool calls yet.</p>
            ) : null}
            {toolCalls.map((toolCall) => (
              <div key={toolCall.toolCallId} className="tool-row">
                <div>
                  <strong>{toolCall.toolName}</strong>
                  <span>{toolCall.executionPolicy}</span>
                </div>
                <span className={`pill pill-${toolCall.status}`}>
                  {toolCall.status}
                </span>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}

async function registerTencentMapMcpTools(): Promise<RemoteMcpStatus> {
  const apiKey = getTencentMapMcpKey();
  if (!apiKey) {
    return {
      state: "failed",
      reason: "missing VITE_TENCENT_MAP_MCP_KEY",
    };
  }

  const url = new URL("/mcp/tencent-map", window.location.origin);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("format", "0");

  try {
    const result = await registerManagedMcpHttpClientTools(demoClient, {
      url,
      namePrefix: "tencent_map_",
      clientName: "mido-web-demo",
      clientVersion: "0.1.0",
    });

    return {
      state: "connected",
      toolCount: result.tools.length,
    };
  } catch (error) {
    console.error("Failed to connect Tencent Map MCP server:", error);
    return {
      state: "failed",
      reason: error instanceof Error ? error.message : "unknown error",
    };
  }
}

function getTencentMapMcpKey(): string {
  return (
    (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
      .env?.VITE_TENCENT_MAP_MCP_KEY ?? ""
  ).trim();
}

function toChatTurns(messages: AgentMessage[]): ChatTurn[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") {
      return [];
    }

    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!text) {
      return [];
    }

    return [
      {
        id: message.id,
        role: message.role,
        text,
      },
    ];
  });
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return "-";
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatUsage(
  modelCalls: ReturnType<typeof buildRunTrace>["modelCalls"],
): string {
  const totalTokens = modelCalls.reduce((sum, modelCall) => {
    return sum + (modelCall.usage?.totalTokens ?? 0);
  }, 0);

  return totalTokens > 0 ? `${totalTokens}` : "-";
}

function formatToolkitLabel(value: unknown): string {
  if (!isRecord(value)) {
    return "unknown";
  }

  const enabled = value.enabled === true;
  const toolCount = typeof value.toolCount === "number" ? value.toolCount : 0;
  const reason = typeof value.reason === "string" ? value.reason : "unknown";
  return enabled ? `${toolCount} server tools` : `disabled (${reason})`;
}

function formatSkillLabel(
  status: SkillCatalogStatus,
  skills: ClientSkillSummary[],
): string {
  if (status === "loading") {
    return "loading...";
  }

  if (status === "failed") {
    return "unavailable";
  }

  const enabledCount = skills.filter((skill) => skill.enabled).length;
  return `${enabledCount}/${skills.length} enabled`;
}

function readDemoSkills(payload: unknown): ClientSkillSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) {
    return [];
  }

  return payload.skills.flatMap((value) => {
    const skill = readDemoSkill(value);
    return skill ? [skill] : [];
  });
}

function readDemoSkill(value: unknown): ClientSkillSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readOptionalString(value.id);
  const name = readOptionalString(value.name);
  const description = readOptionalString(value.description);
  const digest = readOptionalString(value.digest);
  if (!id || !name || !description || !digest) {
    return undefined;
  }

  return {
    id,
    name,
    description,
    digest,
    source: readOptionalString(value.source) ?? "demo-server",
    enabled: value.enabled === true,
    hasScripts: value.hasScripts === true,
    status: readSkillStatus(value.status),
    risk: readSkillRisk(value.risk),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSkillStatus(value: unknown): ClientSkillSummary["status"] {
  return value === "blocked" || value === "needs_review" ? value : "ready";
}

function readSkillRisk(value: unknown): ClientSkillSummary["risk"] {
  return value === "medium" || value === "high" ? value : "low";
}

function getSkillProbePrompt(skillId: string): string {
  if (skillId === "client-smoke") {
    return "Answer in one sentence: metadata wiring is active.";
  }

  if (skillId === "support-triage") {
    return "Ticket: customer cannot log in after a password reset and has a deadline in one hour.";
  }

  if (skillId === "json-shape") {
    return "Extract summary, priority, and next action from: invoice approval is blocked for one enterprise customer.";
  }

  return `Run a quick probe for ${skillId}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="export-icon">
      <path
        d="M12 3v10m0 0 3.75-3.75M12 13 8.25 9.25M5 14.5v2.75A1.75 1.75 0 0 0 6.75 19h10.5A1.75 1.75 0 0 0 19 17.25V14.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
