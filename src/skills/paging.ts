// screen add --paginate --search: which of an endpoint's parameters ask for a
// page, a page size and a search term, in any of the four languages. The UI
// for each framework is written next to its normal list screen; this only
// reads the endpoint and decides what the screen can do.

import { ToolError } from '../core/types.ts';

/** One parameter of an endpoint function, as each language's reader gives it. */
export interface PagingParam {
  name: string;
  type: string;
  /** TypeScript: the parameter is a key of this options object ({ page?: number }) rather than its own argument. */
  inObject?: string;
}

export interface Paging {
  /** Ask for the next page with this parameter: a page number (from 1) or an offset (items so far). */
  page?: PagingParam & { mode: 'page' | 'offset' };
  /** Send PAGE_SIZE in this parameter; a shorter page means the end. Without it, an empty page means the end. */
  size?: PagingParam;
  /** Server search: send the text in this parameter. Without it, search filters the loaded items. */
  search?: PagingParam;
  paginate: boolean;
  /** Search on the device, over these string fields of the item. */
  clientSearch: boolean;
  searchFields: string[];
}

export const PAGE_SIZE = 20;
const PAGE = /^(page|pageNumber|pageNo|pageIndex|p)$/i;
const OFFSET = /^(offset|skip|start|from)$/i;
const SIZE = /^(limit|pageSize|perPage|per_page|page_size|size|count|take|first)$/i;
const SEARCH = /^(q|query|search|searchTerm|search_term|term|keyword|keywords|text|filter)$/i;

/** TS parameters, with the keys of an options object ({ page?: number; search?: string }) flattened in. */
export function tsPagingParams(ps: { name: string; type: string }[]): PagingParam[] {
  const out: PagingParam[] = [];
  for (const p of ps) {
    const obj = /^\{([^]*)\}\s*(\|\s*undefined)?$/.exec(p.type.trim());
    if (obj) {
      for (const m of obj[1].matchAll(/(\w+)\??\s*:\s*([^;,]+)[;,]?/g)) out.push({ name: m[1], type: m[2].trim(), inObject: p.name });
    } else out.push({ name: p.name, type: p.type });
  }
  return out;
}

export function detectPaging(params: PagingParam[], opts: { paginate?: boolean; search?: boolean; modelStringFields: string[]; titleField?: string }): Paging {
  const numeric = (t: string) => /^(number|int|Int|Long|Double|num|Int\?|Long\?|int\?|number \| undefined)/.test(t.replace(/\s/g, ' '));
  const find = (re: RegExp, num?: boolean) => params.find((p) => re.test(p.name) && (!num || numeric(p.type)));
  const page = find(PAGE, true);
  const offset = page ? undefined : find(OFFSET, true);
  const size = find(SIZE, true);
  const search = find(SEARCH);
  const paging: Paging = {
    paginate: Boolean(opts.paginate),
    page: page ? { ...page, mode: 'page' } : offset ? { ...offset, mode: 'offset' } : undefined,
    search: opts.search ? search : undefined,
    clientSearch: Boolean(opts.search && !search),
    searchFields: [],
  };
  if (opts.paginate && paging.page) paging.size = size;
  else paging.size = undefined;
  if (!opts.paginate) paging.page = undefined;
  if (opts.paginate && !paging.page) {
    throw new ToolError(
      'no_paging',
      'The endpoint has no page or offset parameter, so the screen cannot ask for the next page.',
      `Its parameters: ${params.map((p) => p.name).join(', ') || 'none'}. Add a page query parameter to the endpoint (codz api add again with ?page=1 in the URL, or api sync from a spec that has it), or leave out --paginate.`,
    );
  }
  if (paging.clientSearch) {
    const fields = [...new Set([opts.titleField, ...opts.modelStringFields].filter((f): f is string => !!f && opts.modelStringFields.includes(f)))];
    if (!fields.length) throw new ToolError('no_search', 'The endpoint has no search parameter, and its items have no text fields to search in.', 'Add a q or search query parameter to the endpoint, or leave out --search.');
    paging.searchFields = fields.slice(0, 4);
  }
  return paging;
}

/** What the screen does, for the summary line. */
export function pagingSummary(p: Paging, more: 'scroll' | 'button' | 'links' = 'scroll'): string {
  const parts: string[] = [];
  if (p.paginate && p.page) parts.push(`loads ${PAGE_SIZE} at a time (${p.page.name}${p.size ? ` + ${p.size.name}` : ''}), ${more === 'scroll' ? 'more as you scroll' : more === 'button' ? 'a Load more button for the next' : 'Previous and Next links'}`);
  if (p.search) parts.push(`searches on the server (${p.search.name})`);
  else if (p.clientSearch) parts.push(`searches the loaded items (${p.searchFields.join(', ')})`);
  return parts.join('; ');
}

export function pagingWarnings(p: Paging): string[] {
  const w: string[] = [];
  if (p.clientSearch) w.push(`The endpoint has no search parameter, so search filters the items already loaded${p.paginate ? ' (not the pages not loaded yet)' : ''}. Add a q or search query parameter to the endpoint to search on the server.`);
  if (p.paginate && !p.size) w.push(`The endpoint has no page-size parameter, so the screen asks for pages until one comes back empty.`);
  return w;
}

/** The arguments for one call, in a language's syntax: route arguments first, then page, size and search. */
export interface CallParts {
  page?: string;
  search?: string;
}

/** TypeScript call arguments: positional ones in order, keys of the options object together. */
export function tsPagingArgs(ps: { name: string; type: string; optional: boolean }[], p: Paging, routeArgs: Map<string, string>, v: CallParts): string {
  const out: string[] = [];
  for (const param of ps) {
    if (routeArgs.has(param.name)) {
      out.push(routeArgs.get(param.name)!);
      continue;
    }
    const keys: string[] = [];
    const own = (x?: PagingParam) => x && (x.inObject ? x.inObject === param.name : x.name === param.name);
    const val = (x: PagingParam | undefined, expr: string | undefined) => (x && expr && own(x) ? (x.inObject ? keys.push(x.name === expr ? x.name : `${x.name}: ${expr}`) : out.push(expr), true) : false);
    const handled = [val(p.page, v.page), val(p.size, v.page && p.size ? 'PAGE_SIZE' : undefined), val(p.search, v.search)].some(Boolean);
    if (keys.length) out.push(`{ ${keys.join(', ')} }`);
    else if (!handled) {
      if (!param.optional) return out.join(', '); // the caller already reported missing required arguments
      out.push('undefined');
    }
  }
  while (out[out.length - 1] === 'undefined') out.pop();
  return out.join(', ');
}

/** Named arguments (Dart `name: v`, Kotlin `name = v`, Swift `name: v`) for page, size and search. */
export function namedPagingArgs(p: Paging, v: CallParts, sep: ': ' | ' = ', sizeExpr = String(PAGE_SIZE)): string[] {
  const out: string[] = [];
  if (p.page && v.page) out.push(`${p.page.name}${sep}${v.page}`);
  if (p.size && v.page) out.push(`${p.size.name}${sep}${sizeExpr}`);
  if (p.search && v.search) out.push(`${p.search.name}${sep}${v.search}`);
  return out;
}

// ---------- TypeScript (React, React Native) ----------

export interface TsPagedLogic {
  imports: { react: string[]; query: string[] };
  /** Constants above the component (PAGE_SIZE). */
  top: string[];
  /** Lines inside the component, before rendering. Defines items, shown, query, setQuery, loading, error, retry, hasMore, loadMore, refresh, refreshing. */
  body: string[];
}

/**
 * The state and loading for a paged or searchable list: plain React state, or
 * TanStack Query v5 (useInfiniteQuery / useQuery) when the project uses it.
 * `call(v)` gives the endpoint call for a page and a search expression.
 */
export function tsPagedLogic(p: Paging, o: { T: string; call: (v: CallParts) => string; key: string; deps: string[]; reactQuery: boolean; refresh: boolean; hasMore: boolean; access: (v: string, f: string) => string }): TsPagedLogic {
  const first = p.page?.mode === 'offset' ? '0' : '1';
  const top = p.page && p.size ? [`const PAGE_SIZE = ${PAGE_SIZE};`, ''] : [];
  const more = (rows: string) => (p.size ? `${rows}.length === PAGE_SIZE` : `${rows}.length > 0`);
  const searchExpr = p.search ? `search || undefined` : undefined;
  const body: string[] = [];
  const react = new Set<string>();
  const query: string[] = [];
  if (p.search || p.clientSearch) {
    react.add('useState');
    body.push(`  const [query, setQuery] = useState('');`);
  }
  if (p.search) {
    react.add('useEffect');
    body.push(`  const [search, setSearch] = useState('');`, '', '  // Search after a short pause in typing, not on every key.', '  useEffect(() => {', '    const t = setTimeout(() => setSearch(query.trim()), 400);', '    return () => clearTimeout(t);', '  }, [query]);', '');
  }
  const keyParts = [`'${o.key}'`, ...o.deps, ...(p.search ? ['search'] : [])].join(', ');
  if (o.reactQuery && p.paginate) {
    query.push('useInfiniteQuery');
    body.push(
      `  const { data, error, isLoading, ${o.refresh ? 'isFetching, ' : ''}isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useInfiniteQuery({`,
      `    queryKey: [${keyParts}, 'pages'],`,
      `    queryFn: ({ pageParam }) => ${o.call({ page: 'pageParam', search: searchExpr })},`,
      `    initialPageParam: ${first},`,
      `    getNextPageParam: (last, all) => (${more('last')} ? ${p.page!.mode === 'offset' ? 'all.flat().length' : 'all.length + 1'} : undefined),`,
      '  });',
      `  const items: ${o.T}[] = data?.pages.flat() ?? [];`,
      '  const loading = isLoading || isFetchingNextPage;',
      ...(o.hasMore ? ['  const hasMore = Boolean(hasNextPage);'] : []),
      '  const loadMore = () => {',
      '    if (hasNextPage && !isFetchingNextPage) fetchNextPage();',
      '  };',
      '  const retry = () => refetch();',
      ...(o.refresh ? ['  const refresh = () => refetch();', '  const refreshing = isFetching && !isLoading && !isFetchingNextPage;'] : []),
    );
  } else if (o.reactQuery) {
    query.push('useQuery');
    body.push(
      `  const { data, error, isLoading: loading, ${o.refresh ? 'isFetching, ' : ''}refetch } = useQuery({`,
      `    queryKey: [${keyParts}],`,
      `    queryFn: () => ${o.call({ search: searchExpr })},`,
      '  });',
      `  const items: ${o.T}[] = data ?? [];`,
      '  const retry = () => refetch();',
      ...(o.refresh ? ['  const refresh = () => refetch();', '  const refreshing = isFetching && !loading;'] : []),
    );
  } else {
    react.add('useState');
    react.add('useEffect');
    react.add('useRef');
    body.push(
      `  const [items, setItems] = useState<${o.T}[]>([]);`,
      ...(p.paginate ? [`  const [hasMore, setHasMore] = useState(true);`] : []),
      ...(p.paginate && p.page!.mode === 'page' ? [`  const [page, setPage] = useState(${first});`] : []),
      '  const [loading, setLoading] = useState(true);',
      ...(o.refresh ? ['  const [refreshing, setRefreshing] = useState(false);'] : []),
      '  const [error, setError] = useState<unknown>(null);',
      '  // Only the latest request counts: a new search or refresh replaces one still loading.',
      '  const request = useRef(0);',
      '',
      `  /** Loads ${p.paginate ? 'the first page again (reset) or the next one' : 'the list'}. */`,
      `  async function load(${p.paginate ? 'reset: boolean' : ''}) {`,
      '    const id = ++request.current;',
      '    setLoading(true);',
      '    setError(null);',
      '    try {',
      ...(p.paginate ? [`      const next = reset ? ${first} : ${p.page!.mode === 'offset' ? 'items.length' : 'page + 1'};`] : []),
      `      const rows = await ${o.call({ page: p.paginate ? 'next' : undefined, search: searchExpr })};`,
      '      if (id !== request.current) return;',
      ...(p.paginate ? ['      setItems((prev) => (reset ? rows : [...prev, ...rows]));', `      setHasMore(${more('rows')});`, ...(p.page!.mode === 'page' ? ['      setPage(next);'] : [])] : ['      setItems(rows);']),
      '    } catch (e) {',
      '      if (id === request.current) setError(e);',
      '    } finally {',
      '      if (id === request.current) {',
      '        setLoading(false);',
      ...(o.refresh ? ['        setRefreshing(false);'] : []),
      '      }',
      '    }',
      '  }',
      '',
      '  useEffect(() => {',
      `    load(${p.paginate ? 'true' : ''});`,
      '    // eslint-disable-next-line react-hooks/exhaustive-deps',
      `  }, [${[...o.deps, ...(p.search ? ['search'] : [])].join(', ')}]);`,
      '',
      ...(p.paginate ? ['  const loadMore = () => {', '    if (hasMore && !loading && !error) load(false);', '  };'] : []),
      `  const retry = () => load(${p.paginate ? 'items.length === 0' : ''});`,
      ...(o.refresh ? ['  const refresh = () => {', '    setRefreshing(true);', `    load(${p.paginate ? 'true' : ''});`, '  };'] : []),
    );
  }
  if (p.clientSearch) {
    body.push(
      '',
      '  const needle = query.trim().toLowerCase();',
      `  const shown = needle ? items.filter((item) => [${p.searchFields.map((f) => o.access('item', f)).join(', ')}].some((v) => String(v ?? '').toLowerCase().includes(needle))) : items;`,
    );
  } else body.push('  const shown = items;');
  return { imports: { react: [...react], query }, top, body };
}

// ---------- Dart ----------

/** Dart call arguments: positional in order (null for unused optional ones), named as name: value. */
export function dartPagingCall(args: { name: string; type: string; required: boolean; named?: boolean }[], p: Paging, route: Map<string, string>, v: CallParts, sizeExpr: string): string {
  const value = (name: string): string | undefined => {
    if (route.has(name)) return route.get(name);
    if (p.page && v.page && p.page.name === name) return v.page;
    if (p.size && v.page && p.size.name === name) return sizeExpr;
    if (p.search && v.search && p.search.name === name) return v.search;
    return undefined;
  };
  const positional: string[] = [];
  const named: string[] = [];
  for (const a of args) {
    const val = value(a.name);
    if (a.named) {
      if (val !== undefined) named.push(`${a.name}: ${val}`);
    } else positional.push(val ?? 'null');
  }
  while (positional.length && positional[positional.length - 1] === 'null' && !args.filter((a) => !a.named)[positional.length - 1]?.required) positional.pop();
  return [...positional, ...named].join(', ');
}

/** Dart: does any of these String fields of `item` contain `needle` (already lower-case)? */
export function dartSearchMatch(fields: { name: string; nullable: boolean }[], item: string, needle: string, prop: (json: string) => string): string {
  return `[${fields.map((f) => `${item}.${prop(f.name)}${f.nullable ? " ?? ''" : ''}`).join(', ')}].any((v) => v.toLowerCase().contains(${needle}))`;
}
