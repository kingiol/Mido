import type { AgentMessage } from '@mido-agent/protocol-core';

export function selectSummaryWindowMessages(messages: AgentMessage[]): AgentMessage[] {
  const summaryIndex = findLastSummaryIndex(messages);
  if (summaryIndex === -1) {
    return messages;
  }

  const systemMessages = messages.filter(message => message.role === 'system');
  const summaryMessage = messages[summaryIndex];
  const suffix = messages.slice(summaryIndex + 1);
  const firstUserIndex = suffix.findIndex(message => message.role === 'user');
  const retainedSuffix = firstUserIndex === -1 ? [] : suffix.slice(firstUserIndex);
  const windowMessages = [summaryMessage, ...retainedSuffix].filter(
    (message): message is AgentMessage => Boolean(message) && message.role !== 'system'
  );

  return [...systemMessages, ...windowMessages];
}

export function findLastSummaryIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'summary') {
      return index;
    }
  }

  return -1;
}
