"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), docs: $("docs"), empty: $("empty"), exts: $("exts"), bar: $("bar"),
  count: $("count"), log: $("log"), form: $("form"), q: $("q"), mode: $("mode"), send: $("send"),
  status: $("status"), banner: $("banner"), toasts: $("toasts"), clear: $("clear"), hint: $("hint"),
  library: $("library"), scrim: $("scrim"), theme: $("theme"),
};

const state = { docs: [], busy: false, history: [] };
let pollTimer = null;

// ---- small helpers --------------------------------------------------------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function toast(message, kind = "error", ms = 5000) {
  const t = el("div", "toast " + kind, message);
  els.toasts.append(t);
  setTimeout(() => t.remove(), ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* not json */ }
    throw new Error(detail);
  }
  return res.json();
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

const ICONS = {
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
};

// ---- theme ----------------------------------------------------------------
function applyTheme(t) { document.documentElement.dataset.theme = t; }
applyTheme(store.get("ra.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
els.theme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next); store.set("ra.theme", next);
});

// ---- mobile drawer --------------------------------------------------------
function drawer(open) { els.library.classList.toggle("open", open); els.scrim.hidden = !open; }
$("openLib").addEventListener("click", () => drawer(true));
$("closeLib").addEventListener("click", () => drawer(false));
els.scrim.addEventListener("click", () => drawer(false));

// ---- health ---------------------------------------------------------------
async function loadHealth() {
  try {
    const h = await api("/api/health");
    els.exts.textContent = h.extensions.filter((e) => ![".markdown", ".log", ".jpeg"].includes(e)).map((e) => e.slice(1).toUpperCase()).join(" · ") + " — up to " + h.max_upload_mb + " MB";
    els.file.accept = h.extensions.join(",");
    els.status.hidden = false;
    els.status.textContent = h.ready ? "● " + h.model : "● offline";
    els.status.classList.toggle("bad", !h.ready);
    els.banner.hidden = h.ready;
    if (!h.ready) els.banner.textContent = "The engine is unavailable: " + (h.error || "unknown error");
  } catch (e) {
    els.banner.hidden = false;
    els.banner.textContent = "Cannot reach the server: " + e.message;
  }
}

// ---- library --------------------------------------------------------------
const STATUS = { queued: "Queued", processing: "Indexing", ready: "Ready", error: "Failed" };

function renderDocs(docs) {
  state.docs = docs;
  els.docs.replaceChildren();
  els.empty.hidden = docs.length > 0;
  const ready = docs.filter((d) => d.status === "ready").length;
  els.count.textContent = docs.length + (docs.length === 1 ? " document" : " documents") + (docs.length ? " · " + ready + " ready" : "");

  for (const d of docs) {
    const ext = (d.name.split(".").pop() || "").toLowerCase();
    const li = el("li", "doc");
    const type = el("span", "ftype " + ext, ext.slice(0, 4).toUpperCase() || "FILE");
    const name = el("span", "name", d.name); name.title = d.name;
    const meta = el("span", "meta");
    meta.append(el("span", "chip " + d.status, STATUS[d.status] || d.status), el("span", null, fmtSize(d.size)));
    const acts = el("span", "acts");

    if (d.status === "error") {
      const retry = el("button", "mini"); retry.type = "button"; retry.title = "Retry"; retry.setAttribute("aria-label", "Retry " + d.name);
      retry.innerHTML = ICONS.retry;
      retry.onclick = async () => {
        retry.disabled = true;
        try { await api("/api/documents/" + encodeURIComponent(d.id) + "/retry", { method: "POST" }); } catch (e) { toast(e.message); }
        refreshDocs();
      };
      acts.append(retry);
    }

    const del = el("button", "mini danger"); del.type = "button"; del.title = "Remove"; del.setAttribute("aria-label", "Remove " + d.name);
    del.innerHTML = ICONS.trash;
    let armed = false, timer;
    del.onclick = async () => {
      if (!armed) {   // two-step confirm without a modal
        armed = true; del.classList.add("confirm"); del.title = "Click again to confirm";
        timer = setTimeout(() => { armed = false; del.classList.remove("confirm"); del.title = "Remove"; }, 3000);
        return;
      }
      clearTimeout(timer); del.disabled = true;
      try { await api("/api/documents/" + encodeURIComponent(d.id), { method: "DELETE" }); toast("Removed " + d.name, "ok", 2500); }
      catch (e) { toast(e.message); }
      refreshDocs();
    };
    acts.append(del);

    li.append(type, name, acts, meta);
    if (d.error) li.append(el("div", "err", d.error));
    els.docs.append(li);
  }

  renderComposerState();
  clearTimeout(pollTimer);
  if (docs.some((d) => d.status === "queued" || d.status === "processing")) pollTimer = setTimeout(refreshDocs, 2000);
}

async function refreshDocs() {
  try { renderDocs(await api("/api/documents")); } catch (_) { /* transient */ }
}

function upload(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  els.bar.hidden = false; els.bar.firstElementChild.style.width = "0";
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) els.bar.firstElementChild.style.width = (e.loaded / e.total * 100) + "%";
  };
  xhr.onloadend = () => {
    els.bar.hidden = true; els.file.value = "";
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
    if (xhr.status >= 200 && xhr.status < 300) {
      if (body.accepted?.length) toast(body.accepted.length + " file(s) queued for indexing", "ok", 3000);
      (body.rejected || []).forEach((r) => toast(r.name + ": " + r.reason));
    } else {
      toast("Upload failed: " + (body.detail || xhr.statusText || "network error"));
    }
    refreshDocs();
  };
  xhr.send(fd);
}

els.file.addEventListener("change", () => upload(els.file.files));
els.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.file.click(); } });
["dragenter", "dragover"].forEach((t) => els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.remove("over"); }));
els.drop.addEventListener("drop", (e) => upload(e.dataTransfer.files));

// ---- markdown (escape first, then re-introduce a safe subset) -------------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderBlock(lines) {
  if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
    return "<ul>" + lines.map((l) => "<li>" + l.replace(/^\s*[-*]\s+/, "") + "</li>").join("") + "</ul>";
  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l)))
    return "<ol>" + lines.map((l) => "<li>" + l.replace(/^\s*\d+[.)]\s+/, "") + "</li>").join("") + "</ol>";
  return "<p>" + lines.join("<br>") + "</p>";
}

function renderMarkdown(text) {
  const html = escapeHtml(text.trim()).split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    const head = /^#{1,6}\s+(.*)$/.exec(lines[0]);
    if (!head) return renderBlock(lines);
    return "<h4>" + head[1] + "</h4>" + (lines.length > 1 ? renderBlock(lines.slice(1)) : "");
  }).join("");
  return html
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "<em>$1</em>")
    .replace(/【(\d+)】/g, '<span class="cite">$1</span>');
}

// Split "…answer…\n### References\n- [1] file" into body + source list.
function splitSources(text) {
  const m = /\n+#{1,6}\s*References\s*\n([\s\S]*)$/i.exec(text);
  if (!m) return { body: text, sources: [] };
  const sources = [];
  for (const line of m[1].split("\n")) {
    const s = /^\s*[-*]?\s*\[(\d+)\]\s*(.+?)\s*$/.exec(line);
    if (s) sources.push({ n: s[1], name: s[2] });
  }
  return { body: text.slice(0, m.index), sources };
}

// ---- chat -----------------------------------------------------------------
const SUGGESTIONS = [
  "Give me a short summary of my documents.",
  "What are the key people, organisations and dates mentioned?",
  "List the most important facts and figures.",
];

function renderWelcome() {
  const w = el("div", "welcome");
  const img = el("img"); img.src = "/icon.png"; img.alt = "";
  w.append(img, el("h3", null, "What would you like to know?"),
    el("p", null, "Upload documents on the left, then ask questions. Every answer links back to its sources."));
  const list = el("div", "suggest");
  for (const s of SUGGESTIONS) {
    const b = el("button"); b.type = "button"; b.dataset.suggest = "1";
    b.innerHTML = ICONS.spark; b.append(el("span", null, s));
    b.onclick = () => { els.q.value = s; els.form.requestSubmit(); };
    list.append(b);
  }
  w.append(list);
  els.log.append(w);
  renderComposerState();
}

function addMessage(role, text, { error = false, pending = false } = {}) {
  els.log.querySelector(".welcome")?.remove();
  const msg = el("div", "msg " + role + (error ? " error" : ""));
  const avatar = el("div", "avatar");
  if (role === "bot") { const i = el("img"); i.src = "/icon.png"; i.alt = ""; avatar.append(i); } else avatar.textContent = "You";
  const bubble = el("div", "bubble");
  msg.append(avatar, bubble);
  els.log.append(msg);
  if (pending) bubble.innerHTML = '<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>';
  else fillBubble(bubble, role, text, error);
  els.log.scrollTop = els.log.scrollHeight;
  return bubble;
}

function fillBubble(bubble, role, text, error) {
  bubble.replaceChildren();
  if (role === "user" || error) { bubble.textContent = text; return; }
  const { body, sources } = splitSources(text);
  const prose = el("div", "prose"); prose.innerHTML = renderMarkdown(body || "(empty answer)");
  bubble.append(prose);
  if (sources.length) {
    const box = el("div", "sources"); box.append(el("span", null, "Sources"));
    const seen = new Set();
    for (const s of sources) {
      if (seen.has(s.name)) continue; seen.add(s.name);
      const chip = el("span", "src"); chip.append(el("b", null, s.n), el("em", null, s.name)); chip.title = s.name;
      box.append(chip);
    }
    bubble.append(box);
  }
  const tools = el("div", "tools");
  const copy = el("button", null, "Copy"); copy.type = "button";
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(body.trim()); copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1500); }
    catch (_) { toast("Copy is not available in this browser."); }
  };
  tools.append(copy); bubble.append(tools);
}

function saveHistory() { store.set("ra.chat", JSON.stringify(state.history.slice(-40))); }

function loadHistory() {
  let saved = [];
  try { saved = JSON.parse(store.get("ra.chat") || "[]"); } catch (_) { /* corrupt */ }
  state.history = Array.isArray(saved) ? saved.filter((m) => m && typeof m.text === "string") : [];
  if (!state.history.length) return renderWelcome();
  state.history.forEach((m) => addMessage(m.role, m.text));
}

function renderComposerState() {
  const hasReady = state.docs.some((d) => d.status === "ready");
  els.q.placeholder = hasReady ? "Ask a question about your documents…" : "Upload and index a document to start asking…";
  els.send.disabled = state.busy || !hasReady;
  document.querySelectorAll("[data-suggest]").forEach((b) => (b.disabled = !hasReady || state.busy));
  els.hint.textContent = hasReady ? "Answers are grounded in your uploaded files, with sources."
    : state.docs.length ? "Waiting for your documents to finish indexing…" : "Start by uploading a document.";
}

async function ask(question) {
  state.busy = true; renderComposerState();
  addMessage("user", question);
  state.history.push({ role: "user", text: question });
  const bubble = addMessage("bot", "", { pending: true });
  try {
    const r = await api("/api/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, mode: els.mode.value }),
    });
    const answer = r.answer || "(empty answer)";
    fillBubble(bubble, "bot", answer, false);
    state.history.push({ role: "bot", text: answer });
    saveHistory();
  } catch (e) {
    bubble.parentElement.classList.add("error");
    fillBubble(bubble, "bot", e.message, true);
  } finally {
    state.busy = false; renderComposerState();
    els.log.scrollTop = els.log.scrollHeight;
    els.q.focus();
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (!q || state.busy || els.send.disabled) return;
  els.q.value = ""; els.q.style.height = "auto";
  ask(q);
});
els.q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
});
els.q.addEventListener("input", () => {
  els.q.style.height = "auto";
  els.q.style.height = Math.min(els.q.scrollHeight, 160) + "px";
});
els.clear.addEventListener("click", () => {
  state.history = []; saveHistory(); els.log.replaceChildren(); renderWelcome();
});

loadHistory();
loadHealth();
refreshDocs();
