import { createTool, objectSchema } from './tool.js';
import type { BrowserAutomationAdapter, CreateBrowserAutomationToolsOptions, ToolkitToolDefinition } from './types.js';

export function createBrowserAutomationTools(
  adapter: BrowserAutomationAdapter,
  options: CreateBrowserAutomationToolsOptions = {}
): ToolkitToolDefinition[] {
  const policy = options.executionPolicy ?? {};

  return [
    createTool({
      name: 'browser_open',
      description: 'Open a URL or switch the active browser page.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open in the browser.' },
          pageId: { type: 'string', description: 'Optional existing page id to make active instead of opening a new URL.' }
        },
        additionalProperties: true
      },
      policy: { risk: 'medium', effects: ['read', 'network'], scopes: ['browser:page:open'] },
      execute: args => adapter.open(args)
    }),
    createTool({
      name: 'browser_snapshot',
      description: 'Read the current browser page snapshot.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Optional browser page id to snapshot. Defaults to the active page.' },
          selector: { type: 'string', description: 'Optional CSS selector used to focus the snapshot on one element subtree.' }
        },
        additionalProperties: true
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['browser:page:read'] },
      execute: args => adapter.snapshot(args)
    }),
    createTool({
      name: 'browser_click',
      description: 'Click an element on the current browser page.',
      executionPolicy: policy.interact ?? 'client_interactive',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Human-readable element target from the latest snapshot, such as a role label or selector.' },
          selector: { type: 'string', description: 'Optional CSS selector for the element to click.' },
          pageId: { type: 'string', description: 'Optional browser page id. Defaults to the active page.' }
        },
        additionalProperties: true
      },
      policy: { risk: 'high', effects: ['click'], scopes: ['browser:page:interact'] },
      execute: args => adapter.click(args)
    }),
    createTool({
      name: 'browser_type',
      description: 'Type text into an element on the current browser page.',
      executionPolicy: policy.interact ?? 'client_interactive',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Human-readable input target from the latest snapshot, such as a label or selector.' },
          selector: { type: 'string', description: 'Optional CSS selector for the input element.' },
          text: { type: 'string', description: 'Text to type into the target element.' },
          pageId: { type: 'string', description: 'Optional browser page id. Defaults to the active page.' }
        },
        additionalProperties: true
      },
      policy: { risk: 'high', effects: ['write'], scopes: ['browser:page:interact'] },
      execute: args => adapter.type(args)
    }),
    createTool({
      name: 'browser_wait',
      description: 'Wait for navigation, selectors, network idle, or a fixed delay.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          waitFor: {
            type: 'string',
            description: 'Condition to wait for: navigation, selector, network_idle, or timeout.',
            enum: ['navigation', 'selector', 'network_idle', 'timeout']
          },
          selector: { type: 'string', description: 'CSS selector to wait for when waitFor is selector.' },
          timeoutMs: { type: 'number', description: 'Maximum time to wait in milliseconds.' },
          delayMs: { type: 'number', description: 'Fixed delay in milliseconds when waitFor is timeout.' },
          pageId: { type: 'string', description: 'Optional browser page id. Defaults to the active page.' }
        },
        additionalProperties: true
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['browser:page:read'] },
      execute: args => adapter.wait(args)
    }),
    createTool({
      name: 'browser_screenshot',
      description: 'Capture a screenshot of the current browser page or an element.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Optional browser page id. Defaults to the active page.' },
          selector: { type: 'string', description: 'Optional CSS selector for an element screenshot.' },
          fullPage: { type: 'boolean', description: 'Whether to capture the full page instead of the visible viewport.' },
          format: { type: 'string', description: 'Image format to return.', enum: ['png', 'jpeg'] }
        },
        additionalProperties: true
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['browser:page:read'] },
      execute: args => adapter.screenshot(args)
    }),
    createTool({
      name: 'browser_extract',
      description: 'Extract structured data from the current browser page.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Optional browser page id. Defaults to the active page.' },
          selector: { type: 'string', description: 'Optional CSS selector limiting the extraction scope.' },
          instruction: { type: 'string', description: 'Natural-language description of the data to extract.' },
          schema: { ...objectSchema, description: 'Optional JSON schema describing the expected extracted data shape.' }
        },
        additionalProperties: true
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['browser:page:read'] },
      execute: args => adapter.extract(args)
    })
  ];
}
