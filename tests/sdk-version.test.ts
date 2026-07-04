import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MIDO_PROTOCOL_VERSION as aguiProtocolVersion,
  MIDO_SDK_VERSION as aguiSdkVersion
} from '@mido/protocol-agui';
import {
  MIDO_PROTOCOL_VERSION as clientCoreProtocolVersion,
  MIDO_SDK_VERSION as clientCoreSdkVersion
} from '@mido/client-core';
import {
  MIDO_PROTOCOL_VERSION as clientWebProtocolVersion,
  MIDO_SDK_VERSION as clientWebSdkVersion
} from '@mido/client-web';
import {
  MIDO_PROTOCOL_VERSION as conformanceProtocolVersion,
  MIDO_SDK_VERSION as conformanceSdkVersion
} from '@mido/conformance';
import {
  MIDO_PROTOCOL_VERSION as evaluatorProtocolVersion,
  MIDO_SDK_VERSION as evaluatorSdkVersion
} from '@mido/evaluator';
import {
  MIDO_PROTOCOL_VERSION as mcpProtocolVersion,
  MIDO_SDK_VERSION as mcpSdkVersion
} from '@mido/mcp-core';
import {
  MIDO_PROTOCOL_VERSION,
  MIDO_SDK_VERSION
} from '@mido/protocol-core';
import {
  MIDO_PROTOCOL_VERSION as serverProtocolVersion,
  MIDO_SDK_VERSION as serverSdkVersion
} from '@mido/server-sdk';
import {
  MIDO_PROTOCOL_VERSION as toolkitProtocolVersion,
  MIDO_SDK_VERSION as toolkitSdkVersion
} from '@mido/toolkit-core';

const repoRoot = process.cwd();
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };

describe('SDK version exports', () => {
  it('exports the root SDK version from every public TypeScript package', () => {
    expect([
      MIDO_SDK_VERSION,
      aguiSdkVersion,
      clientCoreSdkVersion,
      clientWebSdkVersion,
      conformanceSdkVersion,
      evaluatorSdkVersion,
      mcpSdkVersion,
      serverSdkVersion,
      toolkitSdkVersion
    ]).toEqual(Array(9).fill(rootPackageJson.version));
  });

  it('exports the stable protocol version from every public TypeScript package', () => {
    expect([
      MIDO_PROTOCOL_VERSION,
      aguiProtocolVersion,
      clientCoreProtocolVersion,
      clientWebProtocolVersion,
      conformanceProtocolVersion,
      evaluatorProtocolVersion,
      mcpProtocolVersion,
      serverProtocolVersion,
      toolkitProtocolVersion
    ]).toEqual(Array(9).fill('mido.protocol.v1'));
  });
});
