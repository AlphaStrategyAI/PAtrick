import { digest, type Project, type ResearchRecord } from './domain.js';
import { ingestSource } from './intake.js';
import type { Store } from './store.js';

export function researchSourceKey(url: string): string {
  return url.replace(/#.*$/, '').replace(/\/$/, '');
}

/** Keep each distinct primary excerpt as reference material. It does not start a delivery task. */
export function retainPrimaryResearch(store: Store, project: Project, research: ResearchRecord): void {
  for (const query of research.queries) {
    for (const source of query.sources) {
      if (!source.primary || !source.excerpt.trim()) continue;
      const canonical = researchSourceKey(source.canonicalUrl);
      ingestSource(store, { projects: [project] }, {
        projectId: project.id,
        kind: 'reading',
        purpose: 'reference',
        externalId: `research:${canonical}`,
        revision: digest(source.excerpt),
        title: source.title.slice(0, 80),
        content: source.excerpt.trim(),
        locator: source.url,
        authorId: project.ownerId,
        retention: 'permanent',
      });
    }
  }
}
