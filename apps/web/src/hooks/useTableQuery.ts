import { useCallback, useMemo } from "react";
import {
	parseAsArrayOf,
	parseAsInteger,
	parseAsString,
	useQueryStates,
	type UseQueryStatesKeysMap,
} from "nuqs";

/**
 * CRM 风格 `useTableQuery` 的本地版：把 nuqs 批量查询状态聚合成 DataTable 用的
 * `TableQueryState` + `input`（用于实际查询的入参）。比 crm 那份更轻：
 *
 * - 不引 zod，不做 catch-all；filters 直接 `Record<string, string[]>`
 * - 没有 saved view / field 过滤（iTest 用例表、报告表够用）
 * - 排序与翻页等 setter 行为与 CRM 一致：`toggleSort(id)` 切方向、`setSort(id)` 直接设
 *
 * 用法：调用方定义 parsers（含 `sort`、`dir`、`page`、`tab` 可选、各 facet 可选），
 * 拿到的 `query` 给 DataTable 用、`input` 给后端列表 API 用。
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
	/** 若 parsers 里有 "tab" key，DataTable 会显示 tabs；这里冗余存 id 方便直接读 */
	tabId?: string;
}

export type TableParsers = UseQueryStatesKeysMap;

export interface UseTableQuery {
	query: TableQueryState;
	input: ListInput;
}

/** 默认 pageSize；调用方可在 parsers 里提供 `pageSize` key 覆盖（URL 同步）。 */
const DEFAULT_PAGE_SIZE = 20;

/** 常用 pageSize 选项；调用方可通过 setPageSize 自由切。 */
export const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

/**
 * 传入 nuqs parser map 与配置，输出 DataTable 用的 `query` + 列表查询用的 `input`。
 * - parsers 必须包含 `sort` / `dir` / `page`，可选 `pageSize` / `q` / `tab` / 任意 facet。
 *   facet 的 key 名建议与 parsers 一致；多选 facet 用 `parseAsArrayOf(parseAsString)`。
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
			if (k === config.tabId) continue; // tab 不进 filters
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

/** 给常用名（priority/scenario/status/tag...）提供默认 array parser。 */
export const facetArrayParser = () => parseAsArrayOf(parseAsString).withDefault([]);

/** 默认 pageSize parser；调用方 merge 进自己的 parsers map。 */
export const pageSizeParser = () => parseAsInteger.withDefault(DEFAULT_PAGE_SIZE);

/** 把 `parsers` 转成 nuqs 需要的 `urlKeys` 形状——本项目 key 名与 url 一致，直接透传即可。 */
function extractUrlKeys(parsers: TableParsers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of Object.keys(parsers)) out[k] = k;
	return out;
}