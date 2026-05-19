import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { JsonObject, JsonValue } from '@mido/protocol-core';

import { createStableId, createTool, objectSchema, rankByText } from './tool.js';
import type {
  CreateSearchAndRetrievalToolsOptions,
  RetrievalDocument,
  RetrievalEntry,
  RetrievalQueryResult,
  RetrievalStore,
  ToolkitToolDefinition
} from './types.js';
import {
  isJsonObject,
  readOptionalBoolean,
  readOptionalJsonObject,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringArray,
  readRequiredString,
  toJsonValue
} from './validation.js';

const DEFAULT_MAX_FETCH_BYTES = 512_000;
const DEFAULT_CHUNK_SIZE = 4_000;

export function createSearchAndRetrievalTools(options: CreateSearchAndRetrievalToolsOptions = {}): ToolkitToolDefinition[] {
  const store = options.store ?? new InMemoryRetrievalStore();
  const policy = options.executionPolicy ?? {};

  return [
    createTool({
      name: 'search_web',
      description: 'Search the web through an application-provided search adapter.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to send to the application-provided web search adapter.' },
          limit: { type: 'number', description: 'Maximum number of search results to return.' },
          recencyDays: { type: 'number', description: 'Optional freshness window in days for recent results.' }
        },
        required: ['query'],
        additionalProperties: false
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['search:web:read'] },
      execute: async args => {
        if (!options.searchProvider) {
          throw new Error('search_web requires a searchProvider adapter');
        }

        const request = {
          query: readRequiredString(args.query, 'query'),
          limit: readOptionalNumber(args.limit, 'limit'),
          recencyDays: readOptionalNumber(args.recencyDays, 'recencyDays')
        };
        const result = await options.searchProvider(request);
        return { results: Array.isArray(result) ? result : result.results };
      }
    }),
    createTool({
      name: 'fetch_url',
      description: 'Fetch text-like content from a URL with size, timeout, and private-network guards.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP or HTTPS URL to fetch.' },
          maxBytes: { type: 'number', description: 'Maximum response bytes to return as text. Defaults to the configured fetch limit.' },
          allowPrivateNetworks: { type: 'boolean', description: 'Whether to allow fetching localhost or private-network URLs. Defaults to false.' }
        },
        required: ['url'],
        additionalProperties: false
      },
      policy: { risk: 'medium', effects: ['read', 'network'], scopes: ['network:url:fetch'] },
      execute: async args => fetchUrl(args, options)
    }),
    createTool({
      name: 'read_document',
      description: 'Convert text, markdown, or HTML content into chunks, or delegate to an application document reader.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Raw text, markdown, or HTML content to split into document chunks.' },
          contentType: { type: 'string', description: 'Optional MIME type or format hint, such as text/html or text/markdown.' },
          source: { type: 'string', description: 'Optional source label or path to attach to returned chunks.' },
          url: { type: 'string', description: 'Optional URL to fetch and read when content is not provided.' },
          chunkSize: { type: 'number', description: 'Maximum characters per chunk. Defaults to the configured document chunk size.' }
        },
        additionalProperties: false
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['document:read'] },
      execute: async args => readDocument(args, options)
    }),
    createTool({
      name: 'retrieval_index',
      description: 'Index documents in an application namespace for later retrieval.',
      executionPolicy: policy.write ?? 'client_interactive',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Retrieval namespace where the documents should be indexed.' },
          documents: {
            type: 'array',
            description: 'Documents to index for later retrieval.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Optional stable document id. A deterministic id is generated when omitted.' },
                text: { type: 'string', description: 'Searchable document text to index.' },
                source: { type: 'string', description: 'Optional source path, URL, or label for the document.' },
                metadata: { ...objectSchema, description: 'Optional structured metadata to store with the document.' }
              },
              required: ['text'],
              additionalProperties: true
            }
          }
        },
        required: ['namespace', 'documents'],
        additionalProperties: false
      },
      policy: { risk: 'high', effects: ['write'], scopes: ['retrieval:index:write'] },
      execute: async args => {
        const namespace = readRequiredString(args.namespace, 'namespace');
        const documents = readDocuments(args.documents);
        const indexed = await store.index(namespace, documents);
        return { namespace, indexed };
      }
    }),
    createTool({
      name: 'retrieval_query',
      description: 'Query indexed documents in an application namespace.',
      executionPolicy: policy.read ?? 'client_auto',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Retrieval namespace to query.' },
          query: { type: 'string', description: 'Natural-language query used to rank indexed documents.' },
          limit: { type: 'number', description: 'Maximum number of retrieval results to return. Defaults to 10.' }
        },
        required: ['namespace', 'query'],
        additionalProperties: false
      },
      policy: { risk: 'low', effects: ['read'], scopes: ['retrieval:index:read'] },
      execute: async args => {
        const namespace = readRequiredString(args.namespace, 'namespace');
        const results = await store.query(namespace, readRequiredString(args.query, 'query'), {
          limit: readOptionalNumber(args.limit, 'limit')
        });
        return { namespace, results };
      }
    }),
    createTool({
      name: 'retrieval_delete',
      description: 'Delete indexed documents from an application namespace.',
      executionPolicy: policy.delete ?? 'client_interactive',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Retrieval namespace to delete from.' },
          ids: {
            type: 'array',
            description: 'Optional document ids to delete. When omitted, all documents in the namespace are deleted.',
            items: { type: 'string', description: 'Indexed document id to delete.' }
          }
        },
        required: ['namespace'],
        additionalProperties: false
      },
      policy: { risk: 'high', effects: ['delete'], scopes: ['retrieval:index:delete'] },
      execute: async args => store.delete(readRequiredString(args.namespace, 'namespace'), readOptionalStringArray(args.ids, 'ids'))
    })
  ];
}

export class InMemoryRetrievalStore implements RetrievalStore {
  private readonly entries = new Map<string, RetrievalEntry>();

  index(namespace: string, documents: RetrievalDocument[]): RetrievalEntry[] {
    const now = new Date().toISOString();
    const entries = documents.map(document => {
      const id = document.id ?? createStableId('doc', `${namespace}:${document.source ?? ''}:${document.text}`);
      const entry: RetrievalEntry = {
        id,
        namespace,
        text: document.text,
        source: document.source,
        metadata: document.metadata,
        createdAt: now
      };
      this.entries.set(`${namespace}:${id}`, entry);
      return entry;
    });
    return entries;
  }

  query(namespace: string, query: string, options: { limit?: number } = {}): RetrievalQueryResult[] {
    return rankByText([...this.entries.values()].filter(entry => entry.namespace === namespace), query, entry => entry.text)
      .slice(0, options.limit ?? 10)
      .map(({ item, score }) => ({ ...item, score }));
  }

  delete(namespace: string, ids?: string[]): { deleted: number; namespace: string } {
    let deleted = 0;
    const targetIds = ids ?? [...this.entries.values()].filter(entry => entry.namespace === namespace).map(entry => entry.id);
    for (const id of targetIds) {
      if (this.entries.delete(`${namespace}:${id}`)) {
        deleted += 1;
      }
    }

    return { deleted, namespace };
  }
}

async function fetchUrl(args: JsonObject, options: CreateSearchAndRetrievalToolsOptions): Promise<JsonObject> {
  const url = new URL(readRequiredString(args.url, 'url'));
  const allowPrivateNetworks = readOptionalBoolean(args.allowPrivateNetworks, 'allowPrivateNetworks') ?? options.allowPrivateNetworks ?? false;
  if (!allowPrivateNetworks && (await isPrivateNetworkHost(url.hostname))) {
    throw new Error('fetch_url blocked a private-network URL');
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('fetch_url requires a fetch implementation');
  }

  const response = await fetchImpl(url, { redirect: 'follow' });
  const contentType = response.headers.get('content-type') ?? undefined;
  const buffer = Buffer.from(await response.arrayBuffer());
  const maxBytes = readOptionalNumber(args.maxBytes, 'maxBytes') ?? options.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES;
  const truncated = buffer.byteLength > maxBytes;
  const result: JsonObject = {
    url: response.url,
    status: response.status,
    ok: response.ok,
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    sizeBytes: buffer.byteLength,
    truncated
  };
  if (contentType !== undefined) {
    result.contentType = contentType;
  }

  return result;
}

async function readDocument(args: JsonObject, options: CreateSearchAndRetrievalToolsOptions): Promise<JsonObject> {
  let content = readOptionalString(args.content, 'content');
  let contentType = readOptionalString(args.contentType, 'contentType');
  let source = readOptionalString(args.source, 'source');
  const url = readOptionalString(args.url, 'url');
  const chunkSize = readOptionalNumber(args.chunkSize, 'chunkSize') ?? options.defaultChunkSize ?? DEFAULT_CHUNK_SIZE;

  if (!content && url) {
    const fetched = await fetchUrl({ url }, options);
    content = readRequiredString(fetched.text, 'text');
    contentType = readOptionalString(fetched.contentType, 'contentType');
    source = url;
  }
  if (!content) {
    throw new Error('read_document requires content or url');
  }

  if (options.documentReader) {
    const result = await options.documentReader({ content, contentType, source, chunkSize });
    return { chunks: toJsonValue(Array.isArray(result) ? result : result.chunks) };
  }

  const normalizedText = normalizeDocumentText(content, contentType);
  const result: JsonObject = {
    chunks: chunkText(normalizedText, chunkSize).map((text, index) => ({
      text,
      index
    }))
  };
  if (source !== undefined) {
    result.source = source;
  }
  if (contentType !== undefined) {
    result.contentType = contentType;
  }

  return result;
}

function readDocuments(value: JsonValue | undefined): RetrievalDocument[] {
  if (!Array.isArray(value)) {
    throw new Error('documents must be an array');
  }

  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw new Error(`documents[${index}] must be an object`);
    }

    return {
      id: readOptionalString(item.id, `documents[${index}].id`),
      text: readRequiredString(item.text, `documents[${index}].text`),
      source: readOptionalString(item.source, `documents[${index}].source`),
      metadata: readOptionalJsonObject(item.metadata, `documents[${index}].metadata`)
    };
  });
}

function normalizeDocumentText(content: string, contentType: string | undefined): string {
  if (contentType?.includes('html')) {
    return content
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return content;
}

function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks.length > 0 ? chunks : [''];
}

async function isPrivateNetworkHost(hostname: string): Promise<boolean> {
  const lower = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return true;
  }

  if (isIP(lower)) {
    return isPrivateIpAddress(lower);
  }

  const addresses = await lookup(lower, { all: true, verbatim: false });
  return addresses.some(address => isPrivateIpAddress(address.address));
}

function isPrivateIpAddress(address: string): boolean {
  const lower = address.toLowerCase().replace(/^::ffff:/, '');
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }

  const parts = lower.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
    return false;
  }

  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
