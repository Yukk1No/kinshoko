/** Keep the shortest distinct path suffix visible; full paths remain available in the tooltip. */
export function libraryPathHint(root: string, roots: readonly string[]): string {
  const parts = (path: string) => path.replaceAll("\\", "/").split("/").filter(Boolean);
  const segments = parts(root);
  if (segments.length <= 3) return root;
  for (let depth = 2; depth < segments.length; depth++) {
    const suffix = segments.slice(-depth).join("/").toLowerCase();
    if (roots.every((other) => other === root || parts(other).slice(-depth).join("/").toLowerCase() !== suffix)) {
      const separator = root.includes("\\") ? "\\" : "/";
      return "…" + separator + segments.slice(-depth).join(separator);
    }
  }
  return root;
}
