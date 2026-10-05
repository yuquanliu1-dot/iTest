import {
	ArrowDown,
	ArrowUpDown,
	ArrowUp,
	ChevronDown,
	Filter as FilterIcon,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useDeferredValue,
	useId,
	useMemo,
	useState,
} from "react";

import Button from "./Button";
import Pagination from "./Pagination";
import {
	CardPanel,
	CardPanelEmpty,
} from "./shadcn/card";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "./shadcn/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./Table";
import type { TableQueryState } from "../../hooks/useTableQuery";
import { cn } from "../../lib/cn";

// ── 对齐 crm `@crm/ui/components/data-table` 的 API，但实现上少一些不必要的层
//   （crm 还有 expandable/saved view 等高级特性，iTest 用例/报告表不需要）。
//   样式类串 1:1 移植 crm，便于后续两边改动互相对齐。

export type DataTableColumn<TRow> = {
	id: string;
	header: ReactNode;
	cell: (row: TRow) => ReactNode;
	label?: string;
	sortable?: boolean;
	width?: string;
	align?: "left" | "right" | "center";
	headClassName?: string;
	cellClassName?: string;
	hideable?: boolean;
	defaultHidden?: boolean;
	hideBelow?: "sm" | "md" | "lg";
};

export type DataTableFacet = {
	id: string;
	label: string;
	options: { value: string; label: string }[];
};

export type DataTableTabs = {
	id: string;
	allLabel?: string;
	options: { value: string; label: string }[];
};

export interface TableSelection {
	ids: string[];
	count: number;
	allSelected: boolean;
	someSelected: boolean;
	has: (id: string) => boolean;
	toggle: (id: string, value?: boolean) => void;
	toggleAll: (value?: boolean) => void;
	clear: () => void;
}

export type DataTableSelection<TRow> = {
	state: TableSelection;
	actions: ReactNode;
	rowLabel?: (row: TRow) => string;
};

export type DataTableProps<TRow> = {
	query: TableQueryState;
	columns: DataTableColumn<TRow>[];
	getRowId: (row: TRow) => string;
	rows: TRow[];
	total: number;
	loading?: boolean;
	facets?: DataTableFacet[];
	tabs?: DataTableTabs;
	onRowClick?: (row: TRow) => void;
	selection?: DataTableSelection<TRow>;
	actions?: ReactNode;
	leadingActions?: ReactNode;
	search?: ReactNode;
	meta?: ReactNode;
	empty?: ReactNode;
	className?: string;
	tableClassName?: string;
	/** 容器：默认 CardPanel（CRM 风格）；调用方可传其他节点。 */
	container?: ReactNode;
};

const HIDE_BELOW_CLASS = {
	sm: "hidden sm:table-cell",
	md: "hidden md:table-cell",
	lg: "hidden lg:table-cell",
} as const;

const ALIGN_CLASS = {
	left: "",
	right: "text-right",
	center: "text-center",
} as const;

// 行高亮：与 crm `ROW_ACCENT` 等价（在 table 上靠 `hover:bg-muted/60`）。
// 这里 TableRow 已自带 `hover:bg-muted/60`，不必再加。

function columnLabel<TRow>(column: DataTableColumn<TRow>): string {
	if (column.label) return column.label;
	return typeof column.header === "string" ? column.header : column.id;
}

function SortIndicator({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
	return (
		<span className="text-muted-foreground">
			{active ? (
				dir === "asc" ? (
					<ArrowUp className="size-3" />
				) : (
					<ArrowDown className="size-3" />
				)
			) : (
				<ArrowUpDown className="size-3 opacity-40" />
			)}
		</span>
	);
}

function facetLabel(facet: DataTableFacet, selected: string[]): string {
	if (selected.length === 0) return facet.label;
	if (selected.length === 1) {
		const opt = facet.options.find((o) => o.value === selected[0]);
		return opt?.label ?? facet.label;
	}
	return `${facet.label} (${selected.length})`;
}

function toggleArray(selected: string[], value: string, checked: boolean): string[] {
	return checked ? [...selected, value] : selected.filter((v) => v !== value);
}

// ── 复刻 crm `FacetSubmenu`：无搜索 facet 走 DropdownMenuCheckboxItem 多选 ──
function FacetSubmenu({
	facet,
	selected,
	onChange,
}: {
	facet: DataTableFacet;
	selected: string[];
	onChange: (values: string[]) => void;
}) {
	const hasOptions = facet.options.length > 0;
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<span className="flex-1">{facet.label}</span>
				{selected.length > 0 && (
					<span className="ml-auto mr-2 text-muted-foreground text-xs tabular-nums opacity-60">
						({selected.length})
					</span>
				)}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-72 min-w-52 overflow-hidden">
				{!hasOptions ? (
					<DropdownMenuItem disabled>无可选项</DropdownMenuItem>
				) : (
					<>
						{selected.length > 0 && (
							<>
								<DropdownMenuItem onSelect={() => onChange([])}>Clear</DropdownMenuItem>
								<DropdownMenuSeparator />
							</>
						)}
						{facet.options.map((opt) => {
							const checked = selected.includes(opt.value);
							return (
								<DropdownMenuCheckboxItem
									key={opt.value}
									checked={checked}
									onCheckedChange={(next) => onChange(toggleArray(selected, opt.value, next === true))}
								>
									{opt.label}
								</DropdownMenuCheckboxItem>
							);
						})}
					</>
				)}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

// ── 行选中上下文：DataTable 内层组件统一从同一 selection state 拿数据 ──
const SelectionContext = createContext<TableSelection | null>(null);
function useSelection(): TableSelection | null {
	return useContext(SelectionContext);
}

// ── 当前激活 Tab 单选下拉 ──
function TabsMenu({ tabs, activeTab }: { tabs: DataTableTabs; activeTab: string }) {
	const { setTab } = useQueryFromProps();
	const opt = tabs.options.find((o) => o.value === activeTab);
	const label = opt?.label ?? tabs.allLabel ?? "All";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" size="sm" variant="ghost" className="w-full justify-between sm:w-auto sm:min-w-44">
					<span className="truncate">{label}</span>
					<ChevronDown className="shrink-0 opacity-60" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-52">
				<DropdownMenuRadioGroup value={activeTab} onValueChange={(v) => setTab(v)}>
					<DropdownMenuRadioItem value="all">
						<span className="flex-1">{tabs.allLabel ?? "All"}</span>
					</DropdownMenuRadioItem>
					{tabs.options.map((o) => (
						<DropdownMenuRadioItem key={o.value} value={o.value}>
							<span className="flex-1">{o.label}</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// 用 module-level hook 引用 query state 的 setter。crm 用 prop drilling，这里走 context
// 减少参数传递。DataTable 主组件用 Provider 注入 `{ setTab, setSort, setDir, ... }`。
type QueryActions = Pick<TableQueryState, "setTab" | "setSort" | "setDir" | "toggleSort">;
const QueryActionsContext = createContext<QueryActions | null>(null);
function useQueryFromProps(): QueryActions {
	const v = useContext(QueryActionsContext);
	if (!v) throw new Error("DataTable internal: missing QueryActionsContext");
	return v;
}

export function DataTable<TRow>({
	query,
	columns,
	getRowId,
	rows,
	total,
	loading,
	facets,
	tabs,
	onRowClick,
	selection,
	actions,
	leadingActions,
	search,
	meta,
	empty,
	className,
	tableClassName,
	container,
}: DataTableProps<TRow>) {
	const [filtersOpen, setFiltersOpen] = useState(false);
	const filtersId = useId();
	const deferredRows = useDeferredValue(rows);

	const [hidden, setHidden] = useState<Set<string>>(
		() => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.id)),
	);

	const visibleColumns = useMemo(
		() => columns.filter((c) => !hidden.has(c.id)),
		[columns, hidden],
	);
	const hideable = columns.filter((c) => c.hideable !== false);
	const sortable = columns.filter((c) => c.sortable);

	const activeFacetFilterCount = (facets ?? []).filter(
		(f) => (query.filters[f.id]?.length ?? 0) > 0,
	).length;
	const activeTabFilterCount = tabs && query.tab !== "all" ? 1 : 0;
	const activeFilterCount = activeFacetFilterCount + activeTabFilterCount;

	const selecting = selection != null && selection.state.count > 0;

	const queryActions: QueryActions = useMemo(
		() => ({
			setTab: query.setTab,
			setSort: query.setSort,
			setDir: query.setDir,
			toggleSort: query.toggleSort,
		}),
		[query.setTab, query.setSort, query.setDir, query.toggleSort],
	);

	// iTest `Pagination`：左槽显示 meta，共 N 条 + 每页条数 + 数字页码 + 跳页框，
	// pageSize 走 nuqs URL 状态（query.setPageSize）。
	const paginator = (
		<Pagination
			page={query.page}
			pageSize={query.pageSize}
			total={total}
			onPageChange={(p) => query.setPage(p)}
			onPageSizeChange={(s) => query.setPageSize(s)}
			left={meta}
		/>
	);

	const innerTable = (
		<QueryActionsContext.Provider value={queryActions}>
			<SelectionContext.Provider value={selection?.state ?? null}>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<Table
					className={cn(
						"table-fixed [&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4",
						tableClassName,
					)}
					containerClassName="min-h-0 flex-1 overflow-auto rounded-lg border bg-card"
					overlay={
						deferredRows.length === 0 ? (
							<div className="absolute inset-x-0 top-11 bottom-0 flex items-center justify-center px-4 py-8 text-center text-muted-foreground">
								{loading ? <span className="inline-block size-4 animate-spin rounded-full border-2 border-muted border-t-foreground" /> : (empty ?? "No results found.")}
							</div>
						) : null
					}
				>
					<TableHeader className="sticky top-0 z-10 bg-muted [&_th]:bg-muted [&_tr]:border-0 [&_tr]:shadow-[inset_0_-1px_0_var(--border)]">
						<TableRow>
							{selection && (
								<TableHead className={cn("h-11 w-10 px-3", HIDE_BELOW_CLASS.sm)}>
									<SelectionCheckboxHeader selection={selection} rowCount={deferredRows.length} />
								</TableHead>
							)}
							{visibleColumns.map((c) => {
								const isActive = query.sort === c.id;
								return (
									<TableHead
										key={c.id}
										className={cn(
											"h-11 overflow-hidden px-3 font-normal text-muted-foreground",
											c.width,
											ALIGN_CLASS[c.align ?? "left"],
											c.hideBelow && HIDE_BELOW_CLASS[c.hideBelow],
											c.headClassName,
										)}
										aria-sort={isActive ? (query.dir === "asc" ? "ascending" : "descending") : undefined}
									>
										{c.sortable ? (
											<button
												type="button"
												onClick={() => query.toggleSort(c.id)}
												className={cn(
													"-mx-1 inline-flex items-center gap-1 font-normal text-muted-foreground transition-colors hover:text-foreground",
													c.align === "right" && "-mr-1 flex-row-reverse",
												)}
											>
												{c.header}
												<SortIndicator active={isActive} dir={query.dir} />
											</button>
										) : (
											c.header
										)}
									</TableHead>
								);
							})}
						</TableRow>
					</TableHeader>
					<TableBody>
						{deferredRows.map((row) => {
							const id = getRowId(row);
							const isSelected = selection?.state.has(id) ?? false;
							return (
								<TableRow
									key={id}
									data-state={isSelected ? "selected" : undefined}
									onClick={onRowClick ? () => onRowClick(row) : undefined}
									className={onRowClick ? "cursor-pointer" : undefined}
								>
									{selection && (
										<TableCell className={cn("w-10 px-3 py-3", HIDE_BELOW_CLASS.sm)} onClick={(e) => e.stopPropagation()}>
											<SelectionCheckboxCell selection={selection} rowId={id} rowLabel={selection.rowLabel ? selection.rowLabel(row) : undefined} />
										</TableCell>
									)}
									{visibleColumns.map((c) => (
										<TableCell
											key={c.id}
											className={cn(
												"overflow-hidden px-3 py-3",
												c.width,
												ALIGN_CLASS[c.align ?? "left"],
												c.hideBelow && HIDE_BELOW_CLASS[c.hideBelow],
												c.cellClassName,
											)}
										>
											{c.cell(row)}
										</TableCell>
									))}
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
			</SelectionContext.Provider>
		</QueryActionsContext.Provider>
	);

	return (
		<QueryActionsContext.Provider value={queryActions}>
		<div className={cn("flex min-h-0 flex-1 flex-col gap-3", className)}>
			{selecting && selection ? (
				<div className="flex h-8 items-center gap-2">
					<span className="truncate text-muted-foreground text-xs">
						<span className="font-medium tabular-nums text-foreground">{selection.state.count}</span> selected
					</span>
					<div className="ml-auto flex items-center gap-2">
						{selection.actions}
						<Button type="button" variant="ghost" size="sm" onClick={() => selection.state.clear()}>
							Clear
						</Button>
					</div>
				</div>
			) : null}

			<div className={cn("flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between", selecting && "hidden")}>
				<div className="flex flex-wrap items-center gap-2 lg:flex-1 lg:min-w-0">
					{tabs && <TabsMenu tabs={tabs} activeTab={query.tab} />}
					{leadingActions}
					{search}
				</div>
				{(facets ?? []).length > 0 || sortable.length > 0 || hideable.length > 0 || tabs || actions || leadingActions ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="w-full justify-between sm:hidden"
						aria-expanded={filtersOpen}
						aria-controls={filtersId}
						onClick={() => setFiltersOpen((o) => !o)}
					>
						<span className="flex items-center gap-2">
							<FilterIcon />
							Filters
							{activeFilterCount > 0 && (
								<span className="tabular-nums opacity-60">({activeFilterCount})</span>
							)}
						</span>
						<ChevronDown className={cn("shrink-0 opacity-60 transition-transform", filtersOpen && "rotate-180")} />
					</Button>
				) : null}
				<div
					id={filtersId}
					className={cn(
						"flex-col gap-2 lg:contents",
						filtersOpen ? "flex" : "hidden sm:flex",
					)}
				>
					<div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
						{(facets ?? []).length > 0 && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button type="button" variant="ghost" size="sm" className="justify-start sm:justify-center">
										<FilterIcon data-icon="inline-start" />
										Filters
										{activeFacetFilterCount > 0 && (
											<span className="tabular-nums opacity-60">({activeFacetFilterCount})</span>
										)}
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="min-w-48">
									{facets!.map((f) => (
										<FacetSubmenu
											key={f.id}
											facet={f}
											selected={query.filters[f.id] ?? []}
											onChange={(v) => query.setFilter(f.id, v)}
										/>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						{sortable.length > 0 && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button type="button" variant="ghost" size="sm" className="justify-start sm:justify-center">
										<ArrowUpDown data-icon="inline-start" />
										Sort
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="min-w-48">
									<DropdownMenuLabel>Sort by</DropdownMenuLabel>
									<DropdownMenuRadioGroup value={query.sort} onValueChange={query.setSort}>
										{sortable.map((c) => (
											<DropdownMenuRadioItem key={c.id} value={c.id}>
												{columnLabel(c)}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
									<DropdownMenuSeparator />
									<DropdownMenuRadioGroup value={query.dir} onValueChange={(v) => query.setDir(v === "desc" ? "desc" : "asc")}>
										<DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
										<DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
									</DropdownMenuRadioGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						{hideable.length > 0 && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button type="button" variant="ghost" size="sm" className="justify-start sm:justify-center">
										<FilterIcon data-icon="inline-start" />
										Columns
										<span className="tabular-nums opacity-60">({visibleColumns.length})</span>
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="min-w-48">
									<DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
									{hideable.map((c) => {
										const isVisible = !hidden.has(c.id);
										return (
											<DropdownMenuCheckboxItem
												key={c.id}
												checked={isVisible}
												onCheckedChange={(v) =>
													setHidden((prev) => {
														const next = new Set(prev);
														if (v === true) next.delete(c.id);
														else next.add(c.id);
														return next;
													})
												}
											>
												{columnLabel(c)}
											</DropdownMenuCheckboxItem>
										);
									})}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						{actions}
					</div>
				</div>
			</div>

			{/* 表格 + 容器：内层 flex 让表格占满剩余高度、分页器贴底不溢出 */}
			{container ? (
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					{container}
					{innerTable}
					{paginator}
				</div>
			) : (
				<CardPanel className="flex min-h-0 flex-1 flex-col overflow-hidden">
					{innerTable}
					{paginator}
				</CardPanel>
			)}
		</div>
		</QueryActionsContext.Provider>
	);
}

// ── 选择 checkbox 内层组件：必填从 selection 拿数据 ──────────────────────
function SelectionCheckboxHeader({ selection, rowCount }: { selection: DataTableSelection<never>; rowCount: number }) {
	const s = selection.state;
	const checked = s.allSelected ? true : s.someSelected ? "indeterminate" : false;
	return (
		<input
			type="checkbox"
			aria-label="select all rows on this page"
			className="size-4 cursor-pointer rounded border border-input accent-[color:var(--primary)]"
			checked={checked === true}
			ref={(el) => {
				if (el) el.indeterminate = checked === "indeterminate";
			}}
			disabled={rowCount === 0}
			onChange={(e) => s.toggleAll(e.target.checked)}
		/>
	);
}

function SelectionCheckboxCell({ selection, rowId, rowLabel }: { selection: DataTableSelection<never>; rowId: string; rowLabel?: string }) {
	const s = selection.state;
	return (
		<input
			type="checkbox"
			aria-label={rowLabel ? `select ${rowLabel}` : "select row"}
			className="size-4 cursor-pointer rounded border border-input accent-[color:var(--primary)]"
			checked={s.has(rowId)}
			onChange={(e) => s.toggle(rowId, e.target.checked)}
		/>
	);
}

// 旧的内嵌 Pagination 已由上方外部 Pagination 组件替代；此函数删除。