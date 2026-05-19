import * as clientCore from '@mido/client-core';
import * as clientWeb from '@mido/client-web';
import * as serverSdk from '@mido/server-sdk';

describe('managed MCP public API', () => {
  it('does not export old unmanaged high-level helpers', () => {
    expect('createMcpHttpClientTools' in clientCore).toBe(false);
    expect('registerMcpHttpClientTools' in clientCore).toBe(false);
    expect('createMcpHttpClientTools' in clientWeb).toBe(false);
    expect('registerMcpHttpClientTools' in clientWeb).toBe(false);
    expect('registerMcpHttpServerTools' in serverSdk).toBe(false);
  });

  it('keeps managed helpers and low-level connection primitive available', () => {
    expect(typeof clientCore.connectMcpHttpClient).toBe('function');
    expect(typeof clientCore.createManagedMcpHttpClientTools).toBe('function');
    expect(typeof clientCore.registerManagedMcpHttpClientTools).toBe('function');
    expect(typeof clientWeb.createManagedMcpHttpClientTools).toBe('function');
    expect(typeof clientWeb.registerManagedMcpHttpClientTools).toBe('function');
    expect(typeof serverSdk.registerManagedMcpHttpServerTools).toBe('function');
  });
});
