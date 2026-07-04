import {
  createId,
  type AgentMessage,
  type RunStartRequest,
  type ToolDefinition,
} from "@mido/protocol-core";
import { quoteClientPrompt, wrapServerClientPrompts } from "./prompts/system-priority.js";

export interface SystemPromptContext {
  runId: string;
  threadId?: string;
  request: RunStartRequest;
  tools: ToolDefinition[];
}

export type SystemPromptProvider =
  | string
  | ((
      context: SystemPromptContext,
    ) => Promise<string | undefined> | string | undefined);

export async function applySystemPromptPolicy(
  messages: AgentMessage[],
  context: SystemPromptContext,
  provider?: SystemPromptProvider,
): Promise<AgentMessage[]> {
  const serverPrompt = await resolveSystemPrompt(context, provider);
  if (!serverPrompt) {
    return messages;
  }

  const clientSystemPrompt = extractClientSystemPrompt(messages);
  const nonSystemMessages = messages.filter(
    (message) => message.role !== "system",
  );

  return [
    {
      id: createId("msg"),
      role: "system",
      createdAt: new Date().toISOString(),
      content: [
        {
          type: "text",
          text: wrapSystemPrompt(serverPrompt, clientSystemPrompt),
        },
      ],
    },
    ...nonSystemMessages,
  ];
}

async function resolveSystemPrompt(
  context: SystemPromptContext,
  provider?: SystemPromptProvider,
): Promise<string> {
  const prompt =
    typeof provider === "function" ? await provider(context) : provider;
  return prompt?.trim() ?? "";
}

function wrapSystemPrompt(
  serverPrompt: string,
  clientSystemPrompt: string,
): string {
  if (!clientSystemPrompt) {
    return serverPrompt;
  }

  return wrapServerClientPrompts(serverPrompt, quoteClientPrompt(clientSystemPrompt));
}

function extractClientSystemPrompt(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) =>
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}
