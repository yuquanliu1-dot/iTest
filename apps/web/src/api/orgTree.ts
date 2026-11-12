/**
 * Data-fetch wrapper for the left-side org tree: managers get managed-subtree (with counts),
 * otherwise it falls back to the direct membership list (without counts).
 */
import { api, type OrgManagedNode, type OrgSummary } from './client';

export type OrgTreeNode = {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  memberCount?: number;
  projectCount?: number;
};

export const orgTreeApi = {
  /** Fetch org tree nodes. canManage=true → managed-subtree (with counts); otherwise memberships.
   *  reloadToken/attempt are only used to trigger re-fetching. */
  async list(canManage: boolean, _reloadToken?: number, _attempt?: number): Promise<OrgTreeNode[]> {
    if (canManage) {
      const rows = await api.orgs.managedSubtree();
      return rows.map((o: OrgManagedNode) => ({
        id: o.id,
        name: o.name,
        path: o.path,
        parentId: o.parentId,
        memberCount: o.memberCount,
        projectCount: o.projectCount,
      }));
    }
    const rows = await api.orgs.list();
    return rows.map((o: OrgSummary) => ({ id: o.id, name: o.name, path: `/${o.id}/`, parentId: o.parentId }));
  },
};
