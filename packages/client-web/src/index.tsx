import { useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';

import { createAgentClient, type AgentClient, type AgentTransport, type ClearConversationOptions, type SendMessageOptions } from '@mido-agent/client-core';
import type { ToolCallSnapshot } from '@mido-agent/client-core';
import type { CoreEvent, RunCancelRequest, RunResumeRequest, RunStartRequest } from '@mido-agent/protocol-core';

export { MIDO_PROTOCOL_VERSION, MIDO_SDK_VERSION } from '@mido-agent/client-core';
export type {
  AgentClient,
  AgentTransport,
  ClientSystemPromptContext,
  ClientSystemPromptProvider,
  AgentSkillManager,
  ClearConversationOptions,
  ClientSkillInstallInput,
  ClientSkillRef,
  ClientSkillRisk,
  ClientSkillStatus,
  ClientSkillStore,
  ClientSkillSummary,
  CreateAgentClientOptions,
  CreateAgentSkillManagerOptions,
  CreateManagedMcpHttpClientToolsResult,
  McpClientToolMappingOptions,
  McpClientToolRefreshResult,
  McpHttpClientConnection,
  McpHttpClientOptions,
  McpManagedConnection,
  McpManagedConnectionState,
  McpManagedConnectionStatus,
  McpManagedConnectionStatusListener,
  McpManagedHttpClientOptions,
  McpToolClient,
  RegisterManagedMcpHttpClientToolsResult,
  RegisteredClientTool,
  RetryRunOptions,
  SendMessageOptions,
  ToolCallSnapshot
} from '@mido-agent/client-core';
export {
  connectMcpHttpClient,
  createAgentClient,
  createAgentSkillManager,
  createManagedMcpConnection,
  createManagedMcpHttpClientTools,
  createManagedMcpHttpConnection,
  createMcpClientTools,
  McpConnectionUnavailableError,
  refreshMcpClientTools,
  registerManagedMcpHttpClientTools
} from '@mido-agent/client-core';

export interface BrowserSseTransportOptions {
  runUrl: string;
  resumeUrl: string;
  cancelUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}

export function createBrowserSseTransport(options: BrowserSseTransportOptions): AgentTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('A fetch implementation is required to create the browser transport');
  }

  return {
    async startRun(request: RunStartRequest, requestOptions) {
      const response = await fetchImpl(options.runUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options.headers
        },
        signal: requestOptions?.signal,
        body: JSON.stringify(request)
      });

      return parseSseResponse(response);
    },
    async resume(request: RunResumeRequest, requestOptions) {
      const response = await fetchImpl(options.resumeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options.headers
        },
        signal: requestOptions?.signal,
        body: JSON.stringify(request)
      });

      return parseSseResponse(response);
    },
    async cancelRun(request: RunCancelRequest) {
      if (!options.cancelUrl) {
        return undefined;
      }

      const response = await fetchImpl(options.cancelUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options.headers
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`Transport cancel request failed with status ${response.status}`);
      }

      const payload = await response.json() as { event?: CoreEvent };
      return payload.event;
    }
  };
}

export function useAgentRun(client: AgentClient) {
  const snapshot = useAgentSnapshot(client);

  return {
    ...snapshot,
    startRun: (request: RunStartRequest) => client.startRun(request),
    sendMessage: (text: string, options?: SendMessageOptions) => client.sendMessage(text, options),
    approveToolCall: (toolCallId: string) => client.approveToolCall(toolCallId),
    rejectToolCall: (toolCallId: string, reason?: string) => client.rejectToolCall(toolCallId, reason),
    submitToolResult: (toolCallId: string, output: unknown) => client.submitToolResult(toolCallId, output as never),
    cancelRun: (reason?: string) => client.cancelRun(reason),
    retryLastRun: () => client.retryLastRun(),
    clearConversation: (options?: ClearConversationOptions) => client.clearConversation(options)
  };
}

export function useToolCalls(client: AgentClient) {
  return useAgentSnapshot(client).toolCalls;
}

export function usePendingInteractiveTools(client: AgentClient) {
  return useAgentSnapshot(client).pendingInteractiveTools;
}

export interface AgentReferencePanelProps {
  client: AgentClient;
  title?: string;
}

export function AgentReferencePanel({ client, title = 'Mido Agent SDK' }: AgentReferencePanelProps) {
  const { sendMessage, status, textTranscript } = useAgentRun(client);
  const pendingTools = usePendingInteractiveTools(client);
  const [input, setInput] = useState('');

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input.trim()) {
      return;
    }

    await sendMessage(input);
    setInput('');
  };

  return (
    <section style={panelStyle}>
      <header style={headerStyle}>
        <strong>{title}</strong>
        <span>{status}</span>
      </header>
      <pre style={transcriptStyle}>{textTranscript || 'No assistant output yet.'}</pre>
      {pendingTools.length > 0 ? (
        <div style={toolListStyle}>
          {pendingTools.map(toolCall => (
            <InteractiveToolCard key={toolCall.toolCallId} client={client} toolCall={toolCall} />
          ))}
        </div>
      ) : null}
      <form onSubmit={submitMessage} style={formStyle}>
        <input style={inputStyle} value={input} onChange={event => setInput(event.target.value)} />
        <button type="submit">Send</button>
      </form>
    </section>
  );
}

function InteractiveToolCard({ client, toolCall }: { client: AgentClient; toolCall: ToolCallSnapshot }) {
  return (
    <article style={cardStyle}>
      <div>{toolCall.toolName}</div>
      <pre style={toolArgsStyle}>{JSON.stringify(toolCall.args, null, 2)}</pre>
      <div style={buttonRowStyle}>
        <button type="button" onClick={() => client.approveToolCall(toolCall.toolCallId)}>
          Approve
        </button>
        <button type="button" onClick={() => client.rejectToolCall(toolCall.toolCallId)}>
          Reject
        </button>
      </div>
    </article>
  );
}

function useAgentSnapshot(client: AgentClient) {
  return useSyncExternalStore(
    callback => client.subscribe(callback),
    () => client.getSnapshot(),
    () => client.getSnapshot()
  );
}

async function* parseSseResponse(response: Response): AsyncIterable<CoreEvent> {
  if (!response.ok) {
    throw new Error(`Transport request failed with status ${response.status}`);
  }

  if (!response.body) {
    throw new Error('Transport response does not include a body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const data = parseSseChunk(chunk);
      if (!data) {
        continue;
      }

      yield JSON.parse(data) as CoreEvent;
    }
  }

  if (buffer.trim()) {
    const data = parseSseChunk(buffer);
    if (data) {
      yield JSON.parse(data) as CoreEvent;
    }
  }
}

function parseSseChunk(chunk: string): string | null {
  const lines = chunk.split('\n');
  const dataLines = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim());

  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

const panelStyle = {
  display: 'grid',
  gap: '0.75rem',
  padding: '1rem',
  border: '1px solid #d4d4d8',
  borderRadius: '1rem',
  background: '#fafaf9'
} satisfies CSSProperties;

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center'
} satisfies CSSProperties;

const transcriptStyle = {
  minHeight: '7rem',
  margin: 0,
  padding: '0.75rem',
  borderRadius: '0.75rem',
  background: '#18181b',
  color: '#f4f4f5',
  whiteSpace: 'pre-wrap'
} satisfies CSSProperties;

const toolListStyle = {
  display: 'grid',
  gap: '0.75rem'
} satisfies CSSProperties;

const cardStyle = {
  padding: '0.75rem',
  borderRadius: '0.75rem',
  background: '#ffffff',
  border: '1px solid #e4e4e7'
} satisfies CSSProperties;

const toolArgsStyle = {
  margin: '0.5rem 0',
  padding: '0.5rem',
  borderRadius: '0.5rem',
  background: '#f4f4f5'
} satisfies CSSProperties;

const buttonRowStyle = {
  display: 'flex',
  gap: '0.5rem'
} satisfies CSSProperties;

const formStyle = {
  display: 'flex',
  gap: '0.5rem'
} satisfies CSSProperties;

const inputStyle = {
  flex: 1,
  minWidth: 0
} satisfies CSSProperties;
