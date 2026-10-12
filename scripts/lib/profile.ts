// Shared _profile parser for benchmark scripts (shard CPU durations).
export const WRAPPERS = new Set([
  'BooleanQuery', 'ConstantScoreQuery', 'BoostingQuery', 'DisjunctionMaxQuery',
  'FunctionScoreQuery', 'BoostQuery',
]);

export function categorize(type: string): string {
  if (/LatLon|Geo|PointInSet|Shape|Distance/.test(type)) return 'geo';
  if (/Range|IndexOrDocValues/.test(type)) return 'range';
  if (/Term|MatchAll|Exists|Wildcard|Regexp|Prefix|Fuzzy|Ids/.test(type)) return 'filter_term';
  if (/FunctionScore/.test(type)) return 'function_score';
  if (/MultiTerm|Match|Phrase|Disjunction|Boolean|ConstantScore/.test(type)) return 'text_or_bool';
  return 'other';
}

export function leafAttribution(node: any, out: Record<string, number>) {
  if (!node || typeof node !== 'object') return;
  const type: string = node.type || 'unknown';
  if (WRAPPERS.has(type) && Array.isArray(node.children) && node.children.length > 0) {
    for (const c of node.children) leafAttribution(c.query ?? c, out);
    return;
  }
  const key = categorize(type);
  out[key] = (out[key] || 0) + (node.time_in_nanos || 0);
}

export function parseProfile(profile: any) {
  const queryLeaves: Record<string, number> = {};
  const collectors: Record<string, number> = {};
  const collectorChildren: Record<string, number> = {};
  const aggs: Record<string, number> = {};
  let rewrite = 0;
  let queryMs = 0;
  let collector = 0;
  let fetch = 0;
  let shardCount = 0;

  for (const s of profile?.shards || []) {
    shardCount++;
    for (const srch of s.searches || []) {
      rewrite += srch.rewrite_time || 0;
      for (const q of srch.query || []) {
        queryMs += q.time_in_nanos || 0;
        leafAttribution(q, queryLeaves);
      }
      for (const c of srch.collector || []) {
        collector += c.time_in_nanos || 0;
        collectors[c.name || 'unknown'] = (collectors[c.name || 'unknown'] || 0) + (c.time_in_nanos || 0);
        const walk = (node: any) => {
          for (const ch of node.children || []) {
            const n = ch.name || 'unknown';
            collectorChildren[n] = (collectorChildren[n] || 0) + (ch.time_in_nanos || 0);
            walk(ch);
          }
        };
        walk(c);
      }
    }
    for (const a of s.aggregations || []) {
      const t = a.type || 'unknown';
      aggs[t] = (aggs[t] || 0) + (a.time_in_nanos || 0);
    }
    if (s.fetch) fetch += s.fetch.time_in_nanos || 0;
  }
  const nsMap = (m: Record<string, number>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / 1e6]).sort((a, b) => b[1] - a[1]));
  return {
    shardCount,
    rewriteMs: rewrite / 1e6,
    queryMs: queryMs / 1e6,
    collectorMs: collector / 1e6,
    fetchMs: fetch / 1e6,
    totalShardCpuMs: (rewrite + queryMs + collector + fetch) / 1e6,
    queryLeaves: nsMap(queryLeaves),
    collectors: nsMap(collectors),
    collectorChildren: nsMap(collectorChildren),
    aggs: nsMap(aggs),
  };
}

export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function medianMaps(maps: Record<string, number>[]): Record<string, number> {
  const keys = new Set<string>();
  for (const m of maps) for (const k of Object.keys(m)) keys.add(k);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = median(maps.map((m) => m[k] || 0));
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}
