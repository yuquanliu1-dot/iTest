import { useCallback, useMemo, useState } from "react";

/**
 * 表格批量选择的轻量 hook。
 * API 对齐 crm `@crm/ui/hooks/use-table-selection`（CRM 那个用 Set，状态稍重）。
 *
 * 输入：当前页所有可勾选行的 id；不强制——可以传 `ids.length === 0` 表示无行可勾。
 *
 * 输出：
 * - `ids` 当前已勾选的稳定数组（顺序不保证，便于传给后端 bulk API）
 * - `count` 已勾选数量
 * - `allSelected` 当前页所有 id 都已勾
 * - `someSelected` 当前页有部分已勾（不是全部、不是零）
 * - `has(id)` 是否已勾
 * - `toggle(id, v)` 单行 toggle；v 缺省按当前值取反
 * - `toggleAll(v)` 当前页全部 toggle；v 缺省按 allSelected 取反
 * - `clear()` 清空选择
 */
export function useTableSelection(ids: string[]) {
	// 用 Set 存已选 id，再以"输入 ids 的顺序"导出去重数组 → ids 顺序稳定，避免 React Query key 漂移
	const [selected, setSelected] = useState<Set<string>>(() => new Set());

	const orderedIds = useMemo(() => ids, [ids]);

	const allSelected = orderedIds.length > 0 && orderedIds.every((id) => selected.has(id));
	const someSelected = orderedIds.some((id) => selected.has(id));

	const toggle = useCallback((id: string, value?: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			const v = value ?? !next.has(id);
			if (v) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);

	const toggleAll = useCallback(
		(value?: boolean) => {
			setSelected((prev) => {
				const v = value ?? !allSelected;
				if (!v) {
					// 清空只清当前页里的 id，跨页保持选择
					const next = new Set(prev);
					for (const id of orderedIds) next.delete(id);
					return next;
				}
				const next = new Set(prev);
				for (const id of orderedIds) next.add(id);
				return next;
			});
		},
		[orderedIds, allSelected],
	);

	const clear = useCallback(() => {
		setSelected(new Set());
	}, []);

	const has = useCallback((id: string) => selected.has(id), [selected]);

	const outputIds = useMemo(() => {
		// 优先用当前页 id 的顺序输出已选，便于和上呼交互保持视觉顺序一致
		const seen = new Set<string>();
		const out: string[] = [];
		for (const id of orderedIds) {
			if (selected.has(id) && !seen.has(id)) {
				out.push(id);
				seen.add(id);
			}
		}
		return out;
	}, [orderedIds, selected]);

	return {
		ids: outputIds,
		count: selected.size,
		allSelected,
		someSelected,
		has,
		toggle,
		toggleAll,
		clear,
	};
}