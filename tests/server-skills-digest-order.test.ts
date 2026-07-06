import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('agent skill digest ordering', () => {
  it('keeps skill digests stable when readdir returns files in different orders', async () => {
    const rootDir = await createSkillTree({
      'ordered/SKILL.md': `---
name: ordered
description: Check digest ordering.
---

# Ordered
`,
      'ordered/references/a.md': 'A',
      'ordered/references/b.md': 'B'
    });
    let reverseReferences = false;

    vi.resetModules();
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      const readDir = actual.readdir as unknown as (dir: string | Buffer | URL, options?: unknown) => Promise<unknown>;

      return {
        ...actual,
        readdir: async (dir: string | Buffer | URL, options?: unknown) => {
          const entries = await readDir(dir, options);
          if (Array.isArray(entries) && reverseReferences && isWithFileTypesOption(options) && String(dir).endsWith(`${path.sep}references`)) {
            return [...entries].reverse();
          }

          return entries;
        }
      };
    });
    const { loadAgentSkillsFromDirectory } = await import('@mido-agent/server-sdk');

    const [normalSkill] = await loadAgentSkillsFromDirectory(rootDir);
    reverseReferences = true;
    const [reversedSkill] = await loadAgentSkillsFromDirectory(rootDir);

    expect(normalSkill?.digest).toBe(reversedSkill?.digest);

    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });
});

async function createSkillTree(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'mido-skills-'));

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }

  return rootDir;
}

function isWithFileTypesOption(options: unknown): options is { withFileTypes: true } {
  return typeof options === 'object' && options !== null && 'withFileTypes' in options && options.withFileTypes === true;
}
