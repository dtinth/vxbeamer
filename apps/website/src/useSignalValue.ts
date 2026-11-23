import { effect, type ReadonlySignal } from "@preact/signals-core";
import { useSyncExternalStore } from "react";

/** Read a signal from a React component, re-rendering whenever it changes. */
export function useSignalValue<T>(signal: ReadonlySignal<T>): T {
  return useSyncExternalStore(
    (onChange) => {
      // `effect` runs once straight away; only later runs are changes.
      let first = true;
      return effect(() => {
        void signal.value;
        if (first) first = false;
        else onChange();
      });
    },
    () => signal.peek(),
    () => signal.peek(),
  );
}
