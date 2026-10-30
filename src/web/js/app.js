import { api, int, toast, claimCkb } from "./ui.js";
import * as pages from "./pages.js";
import { mountCharts } from "./charts.js";
import { initBanner } from "./banner.js";

const $ = (s) => document.querySelector(s);
const page = $("#page");
const banner = initBanner($("#banner"));

// [pattern on the path, page, nav section]. The query string (?page=2) is passed separately.
const routes = [
  [/^\/?$/, () => pages.home(), "home"],
  [/^\/blocks$/, (_, q) => pages.blocks(q), "blocks"],
  [/^\/transactions$/, (_, q) => pages.transactions(q), "transactions"],
  [/^\/tx\/(0x[0-9a-f]{64})$/i, (m) => pages.transaction(m[1].toLowerCase()), "transactions"],
  [/^\/block\/(\d+|0x[0-9a-f]{64})$/i, (m) => pages.block(m[1]), "blocks"],
  [/^\/address\/(ck[bt]1[0-9a-z]+)$/i, (m, q) => pages.address(m[1], q), null],
  [/^\/script\/(0x[0-9a-f]{64})\/(type|data|data1|data2)$/i, (m, q) => pages.script(m[1].toLowerCase(), m[2], q), "scripts"],
  [/^\/tokens$/, (_, q) => pages.tokens(q), "tokens"],
  [/^\/token\/(0x[0-9a-f]{64})$/i, (m, q) => pages.token(m[1].toLowerCase(), q), "tokens"],
  [/^\/nfts$/, () => pages.nfts(), "nfts"],
  [/^\/spore\/(0x[0-9a-f]{64})$/i, (m) => pages.spore(m[1].toLowerCase()), "nfts"],
  [/^\/dao$/, (_, q) => pages.dao(q), "dao"],
  [/^\/faucet$/, (_, q) => pages.faucet(q), "faucet"],
  [/^\/charts$/, () => pages.charts(), "charts"],
  [/^\/tools$/, (_, q) => pages.tools(q), "tools"],
  [/^\/scripts$/, (_, q) => pages.scripts(q), "scripts"],
  [/^\/accounts$/, () => pages.accounts(), "accounts"],
];

let refreshTimer = null;
let renderId = 0;
let unmount = null; // cleanup returned by the current page's mount()

function parseHash() {
  const [path, query = ""] = (location.hash.replace(/^#/, "") || "/").split("?");
  return { path, query: new URLSearchParams(query) };
}

async function render({ quiet = false } = {}) {
  const id = ++renderId;
  const { path, query } = parseHash();
  const route = routes.find(([re]) => re.test(path));
  clearInterval(refreshTimer);
  if (!quiet) { unmount?.(); unmount = null; }
  banner.show(route?.[2] === "home");
  // Links that share a section (the Tools tabs) are told apart by their tab.
  const here = location.hash || "#/";
  document.querySelectorAll(".nav a").forEach((a) => {
    const href = a.getAttribute("href");
    const shared = document.querySelectorAll(`.nav a[data-section="${a.dataset.section}"]`).length > 1;
    const current = a.dataset.section === route?.[2] && (!shared || here.startsWith(href) || (!here.includes("tab=") && href.endsWith("tab=address")));
    a.toggleAttribute("aria-current", current);
  });
  document.querySelectorAll(".nav-menu").forEach((m) => {
    m.classList.toggle("current", !!m.querySelector("a[aria-current]"));
    if (!quiet) closeMenu(m); // a live refresh must not shut a menu someone just opened
  });
  if (!quiet) page.innerHTML = `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading</span></div>`;
  $(".topbar").classList.remove("menu-open");
  $("#menu")?.setAttribute("aria-expanded", "false");
  try {
    if (!route) throw new Error("There's no page at this address. Use the search box, or go back home.");
    const result = await route[1](path.match(route[0]), query);
    if (id !== renderId) return; // a newer navigation started while this one loaded
    // Keep expanded rows expanded across live refreshes.
    const open = [...page.querySelectorAll("details")].flatMap((d, i) => (d.open ? [i] : []));
    page.innerHTML = result.html;
    mountCharts(page);
    if (quiet) open.forEach((i) => page.querySelectorAll("details")[i]?.setAttribute("open", ""));
    document.title = `${result.title} · ckb-devnet-explorer`;
    if (!quiet) { window.scrollTo(0, 0); page.focus({ preventScroll: true }); }
    if (result.refresh) refreshTimer = setInterval(() => render({ quiet: true }), 5000);
    // A page can run its own live updates on part of itself (the faucet's claims list) instead
    // of a full refresh that would wipe what someone is typing.
    if (result.mount && !quiet) unmount = result.mount(page) ?? null;
  } catch (err) {
    if (id !== renderId) return;
    page.innerHTML = notFound(err.message);
    document.title = "Not found · ckb-devnet-explorer";
  }
}

// ---- features the server offers (embedded in offckb it runs read-only) ----

function applyFeatures(features = {}) {
  for (const name of ["faucet", "broadcast", "accounts"])
    document.documentElement.dataset[name] = features[name] === false ? "off" : "on";
}

// ---- node status in the top bar ----

let lastTip = null;
let lastResets = null;
async function pollNode() {
  const node = $("#node");
  try {
    const info = await api("/api/info");
    node.classList.add("up");
    node.classList.remove("down");
    node.title = `Connected to ${info.rpcUrl}`;
    $("#node-label").textContent = info.node ? `#${int(info.tip)} · v${info.node.split(" ")[0]}` : `#${int(info.tip)}`;
    applyFeatures(info.features);
    if (lastTip !== null && info.tip !== lastTip) {
      node.classList.remove("tick");
      void node.offsetWidth;
      node.classList.add("tick");
    }
    // `offckb clean` wiped the chain while the page was open.
    if (lastResets !== null && info.resets !== lastResets) {
      toast("The devnet was reset. Showing the new chain.", 5000);
      render();
    }
    banner.setKnowledge(info.knowledgeSize?.bytes);
    lastTip = info.tip;
    lastResets = info.resets;
  } catch (err) {
    node.classList.add("down");
    node.classList.remove("up");
    node.title = err.message;
    $("#node-label").textContent = "offline";
  }
}

// ---- nav menus (their "Blockchain" / "Tokens" dropdowns) ----

function closeMenu(m) {
  m.classList.remove("open");
  m.querySelector("button")?.setAttribute("aria-expanded", "false");
}
document.querySelectorAll(".nav-menu > button").forEach((b) => b.addEventListener("click", (e) => {
  e.stopPropagation();
  const m = b.parentElement;
  const open = !m.classList.contains("open");
  document.querySelectorAll(".nav-menu").forEach(closeMenu);
  m.classList.toggle("open", open);
  b.setAttribute("aria-expanded", String(open));
}));
document.addEventListener("click", (e) => { if (!e.target.closest(".nav-menu")) document.querySelectorAll(".nav-menu").forEach(closeMenu); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const m = document.querySelector(".nav-menu.open");
  if (m) { closeMenu(m); m.querySelector("button").focus(); }
});

// ---- light / dark ----
// The system setting decides until the toggle is used; then the choice is remembered.

const SUN = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const MOON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 12.5A7 7 0 0 1 7.5 3.5a7 7 0 1 0 9 9Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme ?? (systemDark.matches ? "dark" : "light")) === "dark";
function paintToggle() {
  const b = $("#theme");
  const label = isDark() ? "Switch to light mode" : "Switch to dark mode";
  b.innerHTML = isDark() ? SUN : MOON;
  b.setAttribute("aria-label", label);
  b.title = label;
}
$("#theme").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
  paintToggle();
});
systemDark.addEventListener?.("change", paintToggle);
paintToggle();

// ---- search ----

// Every search box (the header, the home page, the not-found page) works the same way.
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("#search, form[data-search]");
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector("input");
  const q = input.value.trim();
  if (!q) return;
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (res.route) {
      input.value = "";
      input.blur();
      if (location.hash === res.route) render(); else location.hash = res.route;
    } else if (form.id === "search") toast(res.error);
    else page.innerHTML = notFound(res.error, q);
  } catch (err) {
    toast(err.message);
  }
});

// Like the CKB Explorer's "Sorry, I can't find it": say why, and offer the search again.
function notFound(message, query = "") {
  const offline = /reach the devnet/i.test(message);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  document.title = `${offline ? "Devnet offline" : "Not found"} · ckb-devnet-explorer`;
  return `<section class="card empty-state">
    <svg class="empty-art" viewBox="0 0 160 96" aria-hidden="true">
      <rect x="8" y="30" width="144" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="6 5"/>
      <rect x="18" y="40" width="16" height="16" rx="3" class="e1"/><rect x="40" y="40" width="30" height="16" rx="3" class="e2"/><rect x="76" y="40" width="22" height="16" rx="3" class="e3"/>
      <text x="124" y="57" text-anchor="middle" class="e4">?</text>
    </svg>
    <h1>${offline ? "The devnet isn't running" : "Sorry, we can't find it"}</h1>
    <p>${esc(message)}</p>
    ${offline ? "<p><code>offckb node</code> starts it; this page reconnects on its own.</p>" : `<form class="big-search" data-search role="search">
      <label class="sr-only" for="q-again">Search again</label>
      <input id="q-again" value="${esc(query)}" placeholder="Block / Transaction / Address / Script Hash / Token / Spore ID" autocomplete="off" spellcheck="false">
      <button class="btn primary" type="submit">Search</button>
    </form>`}
    <p><a href="#/">Back to home</a></p>
  </section>`;
}

// The phone menu: a button that opens the whole nav as a panel under the header.
$("#menu").addEventListener("click", () => {
  const open = !$(".topbar").classList.contains("menu-open");
  $(".topbar").classList.toggle("menu-open", open);
  $("#menu").setAttribute("aria-expanded", String(open));
});

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    $("#q").focus();
  }
});

// ---- toasts, copy buttons, page-size selects ----

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy. Select the text and copy it instead.");
  }
}

// The skip link can't use a #fragment: the hash is the router's.
$(".skip").addEventListener("click", (e) => {
  e.preventDefault();
  page.focus();
});

// The address page's faucet popover: claim straight to the address on screen, with the
// CKB Explorer's two toasts ("Submitted a claim...", then "Claimed...").
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-claim]");
  if (!btn) return;
  e.preventDefault();
  btn.closest("details")?.removeAttribute("open");
  const amount = Number(btn.dataset.amount);
  toast(`Submitted a claim for ${int(amount)} devnet CKB.`, 6000);
  try {
    await claimCkb(btn.dataset.claim, amount);
    toast(`Claimed ${int(amount)} CKB. It lands in the next few blocks.`, 5000);
    const here = location.hash;
    setTimeout(() => { if (location.hash === here) render({ quiet: true }); }, 15000);
  } catch (err) {
    toast(err.message, 6000);
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy], [data-copy-url]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  if (btn.dataset.copy != null) return copy(btn.dataset.copy);
  // Copy what an API URL returns, pretty-printed (e.g. a transaction's raw JSON).
  try {
    const res = await fetch(btn.dataset.copyUrl);
    copy(JSON.stringify(await res.json(), null, 2));
  } catch (err) {
    toast(err.message);
  }
});

// The pager's "Page [ ] Goto" box.
document.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-goto]");
  if (!form) return;
  e.preventDefault();
  const p = Math.min(Number(form.dataset.pages), Math.max(1, Math.floor(Number(form.elements.p.value)) || 1));
  location.hash = form.dataset.goto.replace("{p}", p);
});

document.addEventListener("change", (e) => {
  if (e.target.matches("select[data-nav]")) location.hash = e.target.value;
});

window.addEventListener("hashchange", () => render());
render();
pollNode();
setInterval(pollNode, 4000);
