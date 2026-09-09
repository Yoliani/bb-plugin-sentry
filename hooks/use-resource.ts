// One async read, kept current by the keys it depends on.
//
// A panel component asks for data instead of wiring an effect to it, which puts
// the awkward part of fetching — a response that arrives after something newer
// superseded it — in one place rather than in every view. The sequence guard is
// the whole reason this exists: switch projects quickly and the old project's
// issues must not paint over the new project's.
import { useEffect, useRef, useState } from "react";

export interface Resource<T> {
  /** The last value that arrived for the current keys; null before that. */
  data: T | null;
  /** Set only for the current keys, and cleared by the next attempt. */
  error: string | null;
  /** True while the read for the current keys is outstanding. */
  loading: boolean;
  /** Re-run the read without changing its keys. */
  reload: () => void;
}

export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const [state, setState] = useState<{
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({
    data: null,
    error: null,
    loading: true,
  });
  // The callback changes on every render; the keys decide when to re-read.
  const loadRef = useRef(load);
  loadRef.current = load;
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  // A `reload()` keeps the last value on screen while it refetches; a dependency
  // change (a new project, item, or search) must not paint the previous keys'
  // data, so that is when the pane clears and shows the spinner.
  const previousAttempt = useRef(0);

  useEffect(() => {
    const isReload = previousAttempt.current !== attempt;
    previousAttempt.current = attempt;
    const current = ++seq.current;
    if (isReload) {
      setState((previous) => ({
        data: previous.data,
        error: null,
        loading: true,
      }));
    } else {
      setState({ data: null, error: null, loading: true });
    }
    loadRef.current().then(
      (data) => {
        if (current === seq.current)
          setState({ data, error: null, loading: false });
      },
      (cause: unknown) => {
        if (current !== seq.current) return;
        setState({
          data: null,
          error: cause instanceof Error ? cause.message : String(cause),
          loading: false,
        });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  return {
    ...state,
    reload: () => setAttempt((value) => value + 1),
  };
}
