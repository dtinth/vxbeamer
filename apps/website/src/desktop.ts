export type DesktopSwipeBehavior = "none" | "copy" | "paste";

interface TauriWindow extends Window {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
}

export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  const tauriWindow = window as TauriWindow;
  return (
    typeof tauriWindow.__TAURI__ !== "undefined" ||
    typeof tauriWindow.__TAURI_INTERNALS__ !== "undefined"
  );
}

export async function handleDesktopSwipeBehavior(
  behavior: DesktopSwipeBehavior,
  text: string,
): Promise<void> {
  if (!isDesktopApp()) return;
  const trimmed = text.trim();
  if (!trimmed || behavior === "none") return;

  const { invoke } = await import("@tauri-apps/api/core");

  if (behavior === "copy") {
    await invoke("copy_text_to_clipboard", { text: trimmed });
    return;
  }

  await invoke("paste_text_into_active_app", { text: trimmed });
}
