/** Copy text: the Mac app goes through Electron (always allowed); browsers use the Clipboard API, and plain-http phones fall back to execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.cadre?.copyText) {
      window.cadre.copyText(text);
      return true;
    }
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok;
  } catch {
    return false;
  }
}
