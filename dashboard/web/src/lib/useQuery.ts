import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../api";
import { isFresh, peek } from "./cache";

export interface Query<T> { data: T | null; loading: boolean; stale: boolean; error: string | null; reload: () => void }

interface S<T> { url: string | null; data: T | null; error: string | null; pending: boolean }
const seed = <T,>(url: string | null): S<T> => ({ url, data: url ? peek<T>(url) ?? null : null, error: null, pending: !!url && !isFresh(url) });

// Reads a GET endpoint through the shared cache. Anything already cached is the
// initial state, so a tab that is navigated back to paints its old data on the
// first frame instead of flashing a spinner. Pass null to hold off: waiting on
// meta, or on a selection the user has not made yet.
export function useQuery<T>(url: string | null): Query<T> {
  const [st, setSt] = useState<S<T>>(() => seed<T>(url));
  const [nonce, setNonce] = useState(0);

  // A url change swaps in that url's cached value during render, so the
  // previous selection's data is never shown under a new heading.
  if (st.url !== url) setSt(seed<T>(url));

  useEffect(() => {
    if (!url) return;
    let alive = true;
    apiGet<T>(url)
      .then((d) => alive && setSt((s) => (s.url === url ? { url, data: d, error: null, pending: false } : s)))
      .catch((e) => alive && setSt((s) => (s.url === url ? { ...s, error: String(e), pending: false } : s)));
    return () => { alive = false; };
  }, [url, nonce]);

  const reload = useCallback(() => { setSt((s) => ({ ...s, pending: true })); setNonce((n) => n + 1); }, []);
  const cur = st.url === url ? st : seed<T>(url);
  return { data: cur.data, loading: cur.pending && cur.data === null, stale: cur.pending && cur.data !== null, error: cur.error, reload };
}
