import { describe, expect, it } from 'vitest';
import { memberLabel, roleNamesFrom, userNamesFrom } from '../projects';

const users = userNamesFrom([
  { metadata: { name: 'm-86h52' }, username: 'trainer', displayName: 'trainer' },
  { metadata: { name: 'user-286n2' }, username: 'admin', displayName: 'Default Admin' },
  { metadata: { name: 'u-nodisplay' }, username: 'bob' },
]);
const roles = roleNamesFrom([
  { metadata: { name: 'ai-job-submitter' }, displayName: 'AI Job Submitter' },
  { metadata: { name: 'project-owner' }, displayName: 'Project Owner' },
]);

describe('a project member, as people read it', () => {
  it('names a user and the role', () => {
    expect(memberLabel({ name: 'm-86h52', kind: 'user', role: 'ai-job-submitter' }, users, roles)).toBe('trainer (AI Job Submitter)');
    expect(memberLabel({ name: 'local://user-286n2', kind: 'user', role: 'project-owner' }, users, roles)).toBe('Default Admin (Project Owner)');
    expect(memberLabel({ name: 'u-nodisplay', kind: 'user', role: 'project-owner' }, users, roles)).toBe('bob (Project Owner)');
  });

  it('names a group without its provider prefix', () => {
    expect(memberLabel({ name: 'keycloakoidc_group://developers', kind: 'group', role: 'read-only' }, users, roles)).toBe('developers (group) (read-only)');
  });

  it('shows the id where the name cannot be read', () => {
    expect(memberLabel({ name: 'm-unknown', kind: 'user', role: 'custom-role' }, {}, {})).toBe('m-unknown (custom-role)');
  });
});
