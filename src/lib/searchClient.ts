import type { SearchQueryInput } from './validation';

const SEARCH_API = '/api/search';
const AUTOCOMPLETE_API = '/api/search/autocomplete';

export async function searchProperties(params: SearchQueryInput) {
  const response = await fetch(SEARCH_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    console.error('Search API error:', response.status);
    return null;
  }

  return response.json();
}

export async function autocompleteSearch(query: string) {
  const response = await fetch(`${AUTOCOMPLETE_API}?q=${encodeURIComponent(query)}`);

  if (!response.ok) {
    return { suggestions: [] };
  }

  return response.json();
}

export { SEARCH_API, AUTOCOMPLETE_API };
