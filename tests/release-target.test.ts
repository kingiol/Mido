import { execFileSync, spawnSync } from 'node:child_process';

function resolveReleaseTarget(...args: string[]) {
  const output = execFileSync('node', ['scripts/release-target.mjs', 'resolve', ...args], {
    encoding: 'utf8'
  });
  return JSON.parse(output) as {
    target: string;
    version: string;
    kind: string;
    package_name: string;
    package_path: string;
    tag: string;
    npm_filter: string;
  };
}

describe('release target resolver', () => {
  it('resolves an npm SDK release tag', () => {
    expect(resolveReleaseTarget('server-sdk-v0.1.0')).toEqual({
      target: 'server-sdk',
      version: '0.1.0',
      kind: 'npm',
      package_name: '@mido-agent/server-sdk',
      package_path: 'packages/server-sdk',
      tag: 'server-sdk-v0.1.0',
      npm_filter: '@mido-agent/server-sdk'
    });
  });

  it('resolves the Swift SDK semver tag used by SwiftPM', () => {
    expect(resolveReleaseTarget('v0.1.0')).toEqual({
      target: 'client-ios',
      version: '0.1.0',
      kind: 'swift',
      package_name: 'MidoClient',
      package_path: 'packages/client-ios',
      tag: 'v0.1.0',
      npm_filter: ''
    });
  });

  it('resolves workflow dispatch input', () => {
    expect(resolveReleaseTarget('client-web', '0.1.0')).toMatchObject({
      target: 'client-web',
      version: '0.1.0',
      package_name: '@mido-agent/client-web',
      tag: 'client-web-v0.1.0'
    });
  });

  it('rejects unsupported tags', () => {
    const result = spawnSync('node', ['scripts/release-target.mjs', 'resolve', 'client-ios-v0.1.0'], {
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported release tag "client-ios-v0.1.0"');
  });
});
