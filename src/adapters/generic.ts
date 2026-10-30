// Fallback for projects without a framework adapter: structure, locales and
// config values only.

import { walk } from '../core/fsutil.ts';
import type { Adapter, Conventions, ProjectMap } from '../core/types.ts';
import { emptyMap, fileStats, listRootEnvFiles, scanEnvBaseUrls, scanLocales } from './common.ts';

export const genericAdapter: Adapter = {
  id: 'generic',
  version: '0.1.0',
  capabilities: { explain: true, apiAdd: false },
  supportedSetup: 'Any project: structure, locale files and .env values only.',
  async scan(root: string, conventions: Conventions): Promise<ProjectMap> {
    const map = emptyMap('generic', `generic@${this.version}`);
    const files = walk(root);
    map.stats = fileStats(files);
    map.locales = scanLocales(root, files);
    map.baseUrls = scanEnvBaseUrls(root, listRootEnvFiles(root));
    map.conventions = { ...conventions };
    map.notes.push('No framework adapter matches this project, so only structure, locales and config values are mapped. `api add` needs the Next.js or Flutter adapter.');
    return map;
  },
};
