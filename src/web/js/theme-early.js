// Apply a saved theme before the first paint, so there's no flash of the other one. A file,
// not an inline script, so it runs under a strict Content-Security-Policy (script-src 'self').
try {
  const t = localStorage.getItem("theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
