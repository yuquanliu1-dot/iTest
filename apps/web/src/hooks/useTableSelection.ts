import { useCallback, useMemo, useState } from "react";

/**
 * Lightweight hook for table batch selection.
 * API aligned with crm `@crm/ui/hooks/use-table-selection` (the CRM one uses a Set, slightly heavier state).
 *
 * Input: ids of all selectable rows on the current page; not enforced — `ids.length === 0` may be passed meaning nothing to check.
 *
 * Output:
 * - `ids` stable array of currently checked ids (order not guaranteed, convenient for backend bulk APIs)
 * - `count` number checked
 * - `allSelected` every id on the current page is checked
 * - `someSelected` some (not all, not zero) of the current page are checked
 * - `has(id)` whether checked
 * - `toggle(id, v)` toggle one row; v defaults to inverting the current value
 * - `toggleAll(v)` toggle the whole current page; v defaults to inverting allSelected
 * - `clear()` clear the selection
 */
export function useTableSelection(ids: string[]) {
	// Store selected ids in a Set, then export a deduped array in "input ids order" → stable ids order, avoiding React Query key drift
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
					// Clearing only clears ids on the current page; cross-page selections are kept
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
		// Prefer current-page id order when exporting selections, keeping visual order consistent with the interaction above
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