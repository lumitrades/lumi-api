/** Privacy: keep only protocol + host + path of a URL. Query strings, fragments and userinfo never leave the kit. */
export function originPath(u) {
  let x;
  try { x = new URL(String(u)); } catch { return null; }
  if (x.protocol !== "https:" && x.protocol !== "http:") return null;
  const path = x.pathname.length > 1 ? x.pathname.replace(/\/+$/, "") : "";
  return `${x.protocol}//${x.host.toLowerCase()}${path}`;
}
