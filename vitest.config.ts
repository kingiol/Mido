import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mido-agent/protocol-core': `${root}packages/protocol-core/src/index.ts`,
      '@mido-agent/protocol-agui': `${root}packages/protocol-agui/src/index.ts`,
      '@mido-agent/mcp-core': `${root}packages/mcp-core/src/index.ts`,
      '@mido-agent/server-sdk': `${root}packages/server-sdk/src/index.ts`,
      '@mido-agent/client-core': `${root}packages/client-core/src/index.ts`,
      '@mido-agent/client-web': `${root}packages/client-web/src/index.tsx`,
      '@mido-agent/toolkit-core': `${root}packages/toolkit-core/src/index.ts`,
      '@mido-agent/conformance': `${root}packages/conformance/src/index.ts`,
      '@mido-agent/evaluator': `${root}packages/evaluator/src/index.ts`
    }
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: []
  }
});
