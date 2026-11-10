import { create } from "zustand";

/**
 * In-app replacement for window.prompt, which Electron does not support (it throws). Call
 * `askText(...)` and await the answer: the string, or null when cancelled.
 */
interface AskRequest {
  title: string;
  label?: string;
  value: string;
  placeholder?: string;
  confirmLabel: string;
  /** Allow submitting an empty value (e.g. clearing a section). */
  allowEmpty: boolean;
  resolve: (v: string | null) => void;
}

export const useAsk = create<{ request: AskRequest | null }>(() => ({ request: null }));

export function askText(opts: { title: string; label?: string; value?: string; placeholder?: string; confirmLabel?: string; allowEmpty?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    useAsk.getState().request?.resolve(null);
    useAsk.setState({
      request: {
        title: opts.title,
        label: opts.label,
        value: opts.value ?? "",
        placeholder: opts.placeholder,
        confirmLabel: opts.confirmLabel ?? "Save",
        allowEmpty: opts.allowEmpty ?? false,
        resolve: (v) => {
          useAsk.setState({ request: null });
          resolve(v);
        },
      },
    });
  });
}
