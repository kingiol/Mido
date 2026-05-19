import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mido/protocol-core': `${root}packages/protocol-core/src/index.ts`,
      '@mido/protocol-agui': `${root}packages/protocol-agui/src/index.ts`,
      '@mido/mcp-core': `${root}packages/mcp-core/src/index.ts`,
      '@mido/server-sdk': `${root}packages/server-sdk/src/index.ts`,
      '@mido/client-core': `${root}packages/client-core/src/index.ts`,
      '@mido/client-web': `${root}packages/client-web/src/index.tsx`,
      '@mido/toolkit-core': `${root}packages/toolkit-core/src/index.ts`,
      '@mido/conformance': `${root}packages/conformance/src/index.ts`
    }
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: []
  }
});
