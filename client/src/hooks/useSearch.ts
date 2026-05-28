import { useState, useCallback, useRef } from 'react';

export interface SearchResult {
  _type:      'detection' | 'alert' | 'face' | 'match';
  id:         string;
  // detection fields
  cameraId?:   string;
  cameraName?: string;
  className?:  string;
  confidence?: number;
  isLoitering?: boolean;
  dwellTime?:  number;
  zoneName?:   string;
  zoneId?:     string;
  timestamp?:  string | number;
  attributes?: Record<string, unknown>;
  cropData?:   string;
  // detection — object identity & geometry
  objectId?:    string | number;
  bbox?:        { x: number; y: number; width: number; height: number };
  frameWidth?:  number;
  frameHeight?: number;
  cropWidth?:   number;
  cropHeight?:  number;
  // detection — behavioral tracking metrics
  velocity?:      number | null;
  riskScore?:     number | null;
  circularScore?: number | null;
  pacingScore?:   number | null;
  revisitCount?:  number | null;
  // alert fields
  type?:       string;
  acknowledged?: boolean;
  // face fields
  name?:        string;
  galleryId?:   string;
  galleryType?: string;
  galleryName?: string;
  notes?:       string;
  createdAt?:   string;
  photoData?:   string;
  // match fields (v1.1)
  identity?:    string;
  faceId?:      string;
  matchScore?:  number;
  thumbnail?:   string;
  liveCropData?: string;
}

export interface SearchResponse {
  query:   string;
  total:   number;
  results: SearchResult[];
}

export function useSearch(debounceMs = 300) {
  const [results,  setResults]  = useState<SearchResult[]>([]);
  const [total,    setTotal]    = useState(0);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((
    query: string,
    opts: {
      types?: string;
      from?: string;
      to?: string;
      limit?: number;
      minConfidence?: number;
      maxConfidence?: number;
    } = {}
  ) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!query || query.trim().length === 0) {
      setResults([]);
      setTotal(0);
      setLoading(false);
      setError(null);
      return;
    }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ q: query.trim() });
        if (opts.types)  params.set('types',  opts.types);
        if (opts.from)   params.set('from',   opts.from);
        if (opts.to)     params.set('to',     opts.to);
        if (opts.limit)  params.set('limit',  String(opts.limit));
        if (opts.minConfidence != null && opts.minConfidence > 0)
          params.set('minConfidence', String(opts.minConfidence));
        if (opts.maxConfidence != null && opts.maxConfidence < 1)
          params.set('maxConfidence', String(opts.maxConfidence));

        const res  = await fetch(`/api/search?${params.toString()}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }
        const data: SearchResponse = await res.json();
        setResults(data.results);
        setTotal(data.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Search failed');
        setResults([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    }, debounceMs);
  }, [debounceMs]);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setResults([]);
    setTotal(0);
    setLoading(false);
    setError(null);
  }, []);

  return { results, total, loading, error, search, clear };
}
