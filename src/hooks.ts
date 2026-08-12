import { useCallback, useEffect, useState } from "react";

import { errorMessage } from "./api";

export interface Loader<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (value: T) => void;
}

/**
 * Runs `load` on mount and whenever `deps` change, exposing the result along
 * with a `reload` to call after a mutation.
 */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): Loader<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The caller passes a fresh closure every render, so the dependency list is
  // what decides when to refetch.
  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, loading, reload: run, setData };
}

/** Wraps an action so failures surface as a message instead of a rejection. */
export function useAction(): {
  error: string | null;
  busy: boolean;
  setError: (message: string | null) => void;
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>;
} {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T,>(action: () => Promise<T>) => {
    setBusy(true);
    try {
      const result = await action();
      setError(null);
      return result;
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  return { error, busy, setError, run };
}
