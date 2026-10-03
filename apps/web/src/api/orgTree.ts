/**
 * 组织树左侧所需的数据获取封装：manager 取 managed-subtree（带计数），
 * 否则退化为直接 membership 列表（无计数）。
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
  /** 拉取组织树节点。canManage=true → managed-subtree（带计数）；否则用 memberships。
   *  reloadToken/attempt 仅用于触发重拉。 */
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
