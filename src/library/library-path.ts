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

/** 上级文件夹；拿不到时为空。盘符根目录保留末尾的分隔符，免得拼成相对路径。 */
export function parentFolder(root: string): string | null {
  const trimmed = root.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (at <= 0) return null;
  const parent = trimmed.slice(0, at);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}
