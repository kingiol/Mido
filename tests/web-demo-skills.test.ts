import { resolve } from 'node:path';

import { loadAgentSkillsFromDirectory } from '@mido-agent/server-sdk';

describe('web demo skills', () => {
  it('loads no-script skills for client metadata probes', async () => {
    const skills = await loadAgentSkillsFromDirectory(resolve(process.cwd(), 'apps/web-demo/skills'));

    expect(skills.map(skill => skill.id)).toEqual([
      'client-smoke',
      'json-shape',
      'support-triage'
    ]);
    expect(skills.every(skill => skill.scripts.length === 0)).toBe(true);
    expect(skills.find(skill => skill.id === 'client-smoke')?.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
