/** Public wire types for the dreammate.skills.v1 service protocol. */
export interface SkillSummary {
  id: string;
  source_id: string;
  name: string;
  description: string;
  revision: string;
  compatibility?: string;
  scope?: 'user' | 'system' | 'project';
}
