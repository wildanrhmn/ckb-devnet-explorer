const $ = (sel) => document.querySelector(sel);
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function formatCkb(shannons) {
  const v = BigInt(shannons);
  const whole = v / 100000000n;
  const frac = (v % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

// The bar shows what a cell's capacity pays for, since 1 CKB of capacity pays for 1 byte.
function capacityBar(cell) {
  const capacity = Number(BigInt(cell.capacity) / 100000000n);
  const parts = [
    ["head", 8, "8 B capacity field"],
    ["lock", cell.lock.bytes, `${cell.lock.bytes} B lock`],
    ...(cell.type ? [["type", cell.type.bytes, `${cell.type.bytes} B type`]] : []),
    ...(cell.dataLength ? [["data", cell.dataLength, `${cell.dataLength} B data`]] : []),
  ];
  const freeShannons = BigInt(cell.capacity) - BigInt(cell.occupied) * 100000000n;
  const free = Math.max(0, capacity - cell.occupied);
  // Change cells hold millions of CKB; drawn to scale their bytes would be invisible.
  // Past 3x the occupied size, the free part is cut short and marked with a break.
  const compressed = free > cell.occupied * 3;
  const freeWidth = compressed ? cell.occupied * 1.5 : free;
  const segs = parts.map(([k, n, t]) => `<span class="s-${k}" style="flex:${n}" title="${t}"></span>`).join("");
  const freeLabel = `${formatCkb(freeShannons > 0n ? freeShannons : 0n)} CKB`;
  const tail = free > 0
    ? (compressed ? `<span class="s-break" aria-hidden="true"></span>` : "") +
      `<span class="s-free" style="flex:${freeWidth}" title="${freeLabel} unused"></span>`
    : "";
  return `
    <div class="capbar" role="img" aria-label="${cell.occupied} of ${capacity.toLocaleString("en-US")} bytes used">${segs}${tail}</div>
    <div class="caption">${parts.map((p) => p[1]).join(" + ")} = ${cell.occupied} B used · ${free > 0 ? `${freeLabel} free` : "no free capacity"}</div>`;
}

function scriptName(s) {
  if (!s.resolved.name) return `<span class="name unknown" title="${esc(s.code_hash)}">unknown ${short(s.code_hash)}</span>`;
  const inner = s.resolved.inner;
  const main = inner?.name
    ? `${esc(inner.name)} <span class="src">(${esc(inner.source)})</span>`
    : `${esc(s.resolved.name)} <span class="src">(${esc(s.resolved.source)})</span>`;
  const via = inner ? `<span class="via">run by ${esc(s.resolved.name)}</span>` : "";
  return `<span class="name">${main}</span>${via}`;
}

function dataPreview(cell) {
  if (!cell.dataLength) return "";
  const hex = cell.dataPreview.slice(2);
  const bytes = hex.match(/../g).map((b) => parseInt(b, 16));
  const printable = bytes.length && bytes.every((b) => b === 10 || (b >= 32 && b < 127));
  const text = printable ? `<span class="data-text">"${esc(String.fromCharCode(...bytes))}"</span><br>` : "";
  const shown = hex.length > 96 ? hex.slice(0, 96) + "…" : hex;
  return `<p class="data-preview">${text}0x${shown}</p>`;
}

function cellCard(cell) {
  if (cell.unresolved) return `<div class="cell"><p class="caption">${esc(cell.unresolved)}</p></div>`;
  const op = cell.outPoint;
  return `
    <article class="cell">
      <div class="cell-top">
        <span class="ckb">${formatCkb(cell.capacity)} <small>CKB</small></span>
        ${op ? `<a class="outpoint" href="#/tx/${op.txHash}" title="${op.txHash}:${op.index}">${short(op.txHash)}:${op.index}</a>` : ""}
      </div>
      ${capacityBar(cell)}
      <div class="scripts">
        <div class="script lock"><span class="k">Lock</span><div>${scriptName(cell.lock)}</div></div>
        ${cell.type ? `<div class="script type"><span class="k">Type</span><div>${scriptName(cell.type)}</div></div>` : ""}
        ${cell.dataLength ? `<div class="script data"><span class="k">Data</span><div>${cell.dataLength} bytes${dataPreview(cell)}</div></div>` : ""}
      </div>
    </article>`;
}

async function showTx(hash) {
  const tx = await api(`/api/tx/${hash}`);
  $("#detail").innerHTML = `
    <div class="tx-head">
      <h2 class="eyebrow">Transaction</h2>
      <h1>${tx.hash}</h1>
      <p>${tx.blockNumber !== null ? `<a href="#/block/${tx.blockNumber}">Block ${tx.blockNumber}</a>` : "Not in a block yet"} · ${esc(tx.status)}
        · ${tx.inputs.length} in → ${tx.outputs.length} out</p>
    </div>
    <div class="flow">
      <div class="col"><h2 class="eyebrow">Consumed cells</h2>${tx.inputs.map(cellCard).join("")}</div>
      <div class="arrow" aria-hidden="true">→</div>
      <div class="col"><h2 class="eyebrow">Created cells</h2>${tx.outputs.map(cellCard).join("")}</div>
    </div>`;
}

async function showBlock(n) {
  const b = await api(`/api/block/${n}`);
  $("#detail").innerHTML = `
    <div class="tx-head"><h2 class="eyebrow">Block ${b.number}</h2><h1>${b.hash}</h1></div>
    <ul class="block-list">${b.transactions.map((t) =>
      `<li><a href="#/tx/${t.hash}">${t.hash}</a> <span class="caption">${t.cellbase ? "cellbase (block reward)" : `${t.outputs} outputs`}</span></li>`).join("")}</ul>`;
}

let latest = [];
async function refreshFeed() {
  const { tip, transactions } = await api("/api/transactions?limit=30");
  const tipEl = $("#tip");
  const changed = tipEl.dataset.tip !== String(tip);
  tipEl.dataset.tip = tip;
  tipEl.innerHTML = `tip <b>#${tip}</b>`;
  if (changed) { tipEl.classList.add("fresh"); setTimeout(() => tipEl.classList.remove("fresh"), 50); }
  latest = transactions;
  renderFeed();
}

function renderFeed() {
  const current = location.hash.startsWith("#/tx/") ? location.hash.slice(5) : null;
  $("#feed").innerHTML = latest.length
    ? latest.map((t) => `<li><a href="#/tx/${t.hash}" aria-current="${t.hash === current}">
        <span class="num">#${t.blockNumber}</span><span class="hash">${short(t.hash)}</span>
        <span class="meta">${t.outputs} output${t.outputs === 1 ? "" : "s"} · ${ago(t.timestamp)}</span></a></li>`).join("")
    : `<li class="caption">No transactions yet. Deploy a contract or send a transfer and it will show up here.</li>`;
}

async function route() {
  renderFeed();
  const [, kind, id] = location.hash.split("/");
  try {
    if (kind === "tx" && id) return await showTx(id);
    if (kind === "block" && id) return await showBlock(id);
    if (latest[0]) return (location.hash = `#/tx/${latest[0].hash}`);
    $("#detail").innerHTML = `<div class="note">Pick a transaction on the left, or search for one.</div>`;
  } catch (err) {
    $("#detail").innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

$("#search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) location.hash = `#/tx/${q.toLowerCase()}`;
  else if (/^\d+$/.test(q)) location.hash = `#/block/${q}`;
  else $("#detail").innerHTML = `<div class="error">Enter a 0x-prefixed transaction hash (64 hex characters) or a block number.</div>`;
});
window.addEventListener("hashchange", route);

try { await refreshFeed(); } catch (err) { $("#tip").textContent = err.message; }
route();
setInterval(() => refreshFeed().catch((err) => ($("#tip").textContent = err.message)), 4000);
