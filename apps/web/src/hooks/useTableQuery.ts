import { useCallback, useMemo } from "react";
import {
	parseAsArrayOf,
	parseAsInteger,
	parseAsString,
	useQueryStates,
	type UseQueryStatesKeysMap,
} from "nuqs";

/**
 * Local version of the CRM-style `useTableQuery`: aggregates nuqs batch query state into
 * a `TableQueryState` + `input` (the params used for the actual query) for DataTable. Lighter than the crm one:
 *
 * - No zod, no catch-all; filters are directly `Record<string, string[]>`
 * - No saved view / field filtering (enough for iTest's case and report tables)
 * - Sort/pagination setter behavior matches CRM: `toggleSort(id)` flips direction, `setSort(id)` sets directly
 *
 * Usage: the caller defines parsers (with optional `sort`, `dir`, `page`, `tab`, and optional facets);
 * the resulting `query` feeds DataTable and `input` feeds the backend list API.
 */

export type SortDirection = "asc" | "desc";

export interface TableQueryState {
	sort: string;
	dir: SortDirection;
	page: number;
	pageSize: number;
	tab: string;
	tabId: string | null;
	toggleSort: (id: string) => void;
	setSort: (id: string) => void;
	setDir: (dir: SortDirection) => void;
	setPage: (page: number) => void;
	setPageSize: (pageSize: number) => void;
	setTab: (value: string) => void;
	setFilter: (id: string, selected: string[]) => void;
	filters: Record<string, string[]>;
}

export interface ListInput {
	q: string;
	sort: string;
	dir: SortDirection;
	page: number;
	pageSize: number;
	tab: string;
	tabId: string | null;
	filters: Record<string, string[]>;
}

export interface TableQueryConfig {
	pageSize?: number;
	defaultDir?: SortDirection;
	/** If parsers contain a "tab" key, DataTable shows tabs; the id is redundantly stored here for direct reading */
	tabId?: string;
}

export type TableParsers = UseQueryStatesKeysMap;

export interface UseTableQuery {
	query: TableQueryState;
	input: ListInput;
}

/** Default pageSize; the caller may override by providing a `pageSize` key in parsers (URL-synced). */
const DEFAULT_PAGE_SIZE = 20;

/** Common pageSize options; the caller can switch freely via setPageSize. */
export const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

/**
 * Takes a nuqs parser map and config, outputs the `query` for DataTable + the `input` for list queries.
 * - parsers must include `sort` / `dir` / `page`, optionally `pageSize` / `q` / `tab` / any facet.
 *   Facet key names should match the parsers; multi-select facets use `parseAsArrayOf(parseAsString)`.
 */
export function useTableQuery(
	parsers: TableParsers,
	config: TableQueryConfig = {},
): UseTableQuery {
	const defaultSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
	const defaultDir: SortDirection = config.defaultDir ?? "asc";

	const [raw, setRaw] = useQueryStates(parsers, {
		urlKeys: extractUrlKeys(parsers),
		history: "replace",
	});

	const sort = (raw.sort ?? "") as string;
	const dir = (raw.dir === "desc" ? "desc" : "asc") as SortDirection;
	const pageNum = Number(raw.page ?? 1);
	const page = Number.isFinite(pageNum) && pageNum > 0 ? pageNum : 1;
	const sizeRaw = Number(raw.pageSize ?? defaultSize);
	const pageSize = DEFAULT_PAGE_SIZE_OPTIONS.includes(sizeRaw as (typeof DEFAULT_PAGE_SIZE_OPTIONS)[number])
		? sizeRaw
		: defaultSize;
	const q = (raw.q ?? "") as string;
	const tabRaw = config.tabId ? ((raw as Record<string, unknown>)[config.tabId] as string | null | undefined) : null;
	const tab = (tabRaw ?? "all") as string;

	const filters: Record<string, string[]> = useMemo(() => {
		const out: Record<string, string[]> = {};
		for (const k of Object.keys(parsers)) {
			if (k === "sort" || k === "dir" || k === "page" || k === "q") continue;
			if (k === config.tabId) continue; // tab doesn't go into filters
			const v = (raw as Record<string, unknown>)[k];
			if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
			else if (typeof v === "string" && v) out[k] = [v];
		}
		return out;
	}, [parsers, raw, config.tabId]);

	const setSort = useCallback(
		(id: string) => {
			void setRaw({ sort: id, dir: defaultDir, page: 1 });
		},
		[setRaw, defaultDir],
	);

	const toggleSort = useCallback(
		(id: string) => {
			const currentDir = dir;
			const nextDir: SortDirection = currentDir === "asc" ? "desc" : "asc";
			void setRaw((prev) => {
				const prevSort = (prev.sort ?? "") as string;
				if (prevSort === id) return { dir: nextDir, page: 1 };
				return { sort: id, dir: defaultDir, page: 1 };
			});
		},
		[setRaw, dir, defaultDir],
	);

	const setDir = useCallback(
		(next: SortDirection) => {
			void setRaw({ dir: next, page: 1 });
		},
		[setRaw],
	);

	const setPage = useCallback(
		(next: number) => {
			void setRaw({ page: next });
		},
		[setRaw],
	);

	const setPageSize = useCallback(
		(next: number) => {
			void setRaw({ pageSize: next, page: 1 } as Record<string, number>);
		},
		[setRaw],
	);

	const setTab = useCallback(
		(value: string) => {
			if (!config.tabId) return;
			void setRaw({ [config.tabId]: value, page: 1 } as Record<string, string>);
		},
		[setRaw, config.tabId],
	);

	const setFilter = useCallback(
		(id: string, selected: string[]) => {
			void setRaw({ [id]: selected, page: 1 } as Record<string, string[]>);
		},
		[setRaw],
	);

	const query: TableQueryState = useMemo(
		() => ({
			sort,
			dir,
			page,
			pageSize,
			tab,
			tabId: config.tabId ?? null,
			toggleSort,
			setSort,
			setDir,
			setPage,
			setPageSize,
			setTab,
			setFilter,
			filters,
		}),
		[sort, dir, page, pageSize, tab, config.tabId, toggleSort, setSort, setDir, setPage, setPageSize, setTab, setFilter, filters],
	);

	const input: ListInput = useMemo(
		() => ({ q, sort, dir, page, pageSize, tab, tabId: config.tabId ?? null, filters }),
		[q, sort, dir, page, pageSize, tab, config.tabId, filters],
	);

	return { query, input };
}

/** Provides a default array parser for common names (priority/scenario/status/tag...). */
export const facetArrayParser = () => parseAsArrayOf(parseAsString).withDefault([]);

/** Default pageSize parser; the caller merges it into their own parsers map. */
export const pageSizeParser = () => parseAsInteger.withDefault(DEFAULT_PAGE_SIZE);

/** Convert `parsers` into the `urlKeys` shape nuqs needs — in this project key names equal the url ones, pass through directly. */
function extractUrlKeys(parsers: TableParsers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of Object.keys(parsers)) out[k] = k;
	return out;
}