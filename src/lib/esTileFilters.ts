// Thin bridge so map-data tile path reuses the exact same filtered population
// as list/markers (buildFilters shared). Traceable, no duplicated logic.
export { buildFilters as buildFiltersForTiles } from '@/lib/esQueryBuilder';
