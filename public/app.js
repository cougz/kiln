// kiln frontend — no build step, vanilla JS hash router over the REST API
// (src/api.ts). Kept intentionally small: a project gallery, a project
// detail view, and a build page with report + renders + artifact links.
// Styling follows the Kumo token spec (see style.css).

const $app = document.getElementById("app");
const $status = document.getElementById("status");

let serviceStatus = { state: "checking", health: null, checkedAt: null };
let serviceRequest = 0;

function statusLabel() {
  if (serviceStatus.state === "operational") return "Operational";
  if (serviceStatus.state === "degraded") return "Degraded";
  if (serviceStatus.state === "offline") return "Unavailable";
  return "Checking";
}

function renderServiceStatus() {
  const { state, health, checkedAt } = serviceStatus;
  $status.className = `status status--${state}`;
  $status.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${esc(statusLabel())}`;
  $status.title = "Open service status";

  const panel = $app.querySelector("[data-service-status]");
  if (!panel) return;
  const dependencies = health
    ? [
        ["D1 metadata", health.d1],
        ["R2 archive", health.r2],
        ["MCP gateway", health.mcp],
      ]
    : [["Service check", null]];
  const message = state === "operational"
    ? "Build metadata, immutable artifacts, and MCP are ready."
    : state === "degraded"
      ? "Some dependencies are unavailable. New builds or artifact retrieval may fail."
      : state === "offline"
        ? "The API could not be reached. Existing pages may show cached information."
        : "Verifying the Worker and its storage bindings.";
  panel.className = `service-status service-status--${state}`;
  panel.innerHTML = `
    <div class="service-status__heading">
      <div>
        <div class="eyebrow">// SERVICE STATUS</div>
        <h2>${esc(statusLabel())}</h2>
      </div>
      <button class="k-btn k-btn--ghost k-btn--sm" type="button" data-refresh-status>Refresh</button>
    </div>
    <p>${esc(message)}</p>
    <div class="service-status__meta">
      ${dependencies.map(([name, ok]) => `
        <span class="service-check ${ok === true ? "is-up" : ok === false ? "is-down" : "is-checking"}">
          <span aria-hidden="true"></span>${esc(name)}: ${ok === true ? "ready" : ok === false ? "unavailable" : "checking"}
        </span>
      `).join("")}
    </div>
    <div class="service-status__foot">${health?.phase ? `phase ${esc(health.phase)} · ` : ""}${checkedAt ? `checked ${esc(fmtDate(checkedAt))}` : "awaiting response"}</div>
  `;
}

async function refreshServiceStatus() {
  const request = ++serviceRequest;
  serviceStatus = { ...serviceStatus, state: "checking" };
  renderServiceStatus();
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const health = await response.json();
    if (request !== serviceRequest) return;
    serviceStatus = {
      state: health.ok ? "operational" : "degraded",
      health,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    if (request !== serviceRequest) return;
    serviceStatus = { state: "offline", health: null, checkedAt: new Date().toISOString() };
  }
  renderServiceStatus();
}

// WebMCP is a progressive enhancement. These read-only tools mirror the
// public gallery without granting a browser agent additional write access.
if (document.modelContext?.registerTool) {
  const webMcp = new AbortController();
  const register = (tool) => document.modelContext.registerTool(tool, { signal: webMcp.signal }).catch(() => {});
  register({
    name: "kiln.list_projects",
    title: "List kiln projects",
    description: "List the public parametric CAD projects available in kiln.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async () => api("/projects"),
  });
  register({
    name: "kiln.get_project",
    title: "Get kiln project",
    description: "Get a public kiln project's versioned sources and recent build summaries.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Project slug" } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ slug }) => api(`/projects/${encodeURIComponent(slug)}`),
  });
  addEventListener("pagehide", () => webMcp.abort(), { once: true });
}

const api = (path) => fetch(`/api${path}`).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  return body;
});

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

// API timestamps are ISO 8601 UTC ("...Z"); render in the viewer's local
// timezone with an explicit zone label. Bare "YYYY-MM-DD HH:MM:SS" from
// older responses is UTC too — normalize before parsing.
const fmtDate = (s) => {
  if (!s) return "";
  const d = new Date(/[Z+]/.test(s) ? s : s.replace(" ", "T") + "Z");
  return isNaN(d)
    ? s
    : d.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
};

const badge = (status) =>
  `<span class="k-tag ${esc(status)}">${esc(status)}</span>`;

// Artifact paths come from build scripts (untrusted input) — encode every
// segment so a crafted filename can't break out of an attribute or URL.
function artifactUrl(slug, buildId, path) {
  const p = String(path).split("/").map(encodeURIComponent).join("/");
  return `/api/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}/artifacts/${p}`;
}

// --- render lightbox -------------------------------------------------------
// Click a render thumbnail to open it full-screen; click again to toggle
// between "fit to screen" and native-resolution (cursor-following) zoom,
// so fine detail in a render is actually inspectable. Close via the ×
// button, Escape, or clicking the backdrop.

let $lightbox = null;

function ensureLightbox() {
  if ($lightbox) return $lightbox;
  $lightbox = document.createElement("div");
  $lightbox.className = "lightbox";
  $lightbox.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="Close">&times;</button>
    <img class="lightbox-img" alt="">
    <div class="lightbox-hint">click to zoom · Esc to close</div>
  `;
  document.body.appendChild($lightbox);

  const $img = $lightbox.querySelector(".lightbox-img");

  const close = () => {
    $lightbox.classList.remove("open");
    $img.classList.remove("zoomed");
  };

  $lightbox.addEventListener("click", (e) => {
    if (e.target === $img) {
      if ($img.classList.contains("zoomed")) {
        $img.classList.remove("zoomed");
      } else {
        // zoom in centered on the click position
        const r = $img.getBoundingClientRect();
        const ox = ((e.clientX - r.left) / r.width) * 100;
        const oy = ((e.clientY - r.top) / r.height) * 100;
        $img.style.transformOrigin = `${ox}% ${oy}%`;
        $img.classList.add("zoomed");
      }
      return;
    }
    close();
  });
  $lightbox.querySelector(".lightbox-close").addEventListener("click", close);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $lightbox.classList.contains("open")) close();
  });

  return $lightbox;
}

function openLightbox(src, alt) {
  const box = ensureLightbox();
  const $img = box.querySelector(".lightbox-img");
  $img.classList.remove("zoomed");
  $img.src = src;
  $img.alt = alt || "";
  box.classList.add("open");
}

function renderThumb(src, alt) {
  return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" data-lightbox>`;
}

// --- markdown ---------------------------------------------------------------
// Small renderer for build docs (INSTRUCTIONS/BOM/etc.). Everything is
// HTML-escaped before inline markup is applied, and link hrefs are limited
// to http(s)/relative/# — doc content comes from untrusted build scripts.

function mdInline(s) {
  // s is already escaped
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, href) =>
      /^(https?:\/\/|\/|#|\.)/.test(href) ? `<a href="${href}" rel="noopener">${t}</a>` : m);
}

function mdToHtml(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let i = 0;
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${mdInline(esc(para.join(" ")))}</p>`); para = []; }
  };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(buf.join("\n"))}</pre>`);
      continue;
    }
    if (
      line.includes("|") && i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")
    ) {
      flushPara(); closeList();
      const cells = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
        .split("|").map((c) => mdInline(esc(c.trim())));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) rows.push(cells(lines[i++]));
      out.push(
        `<table><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
        `</table>`,
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      flushPara(); closeList();
      const n = Math.min(h[1].length + 3, 6); // demote: doc # renders below card h3
      out.push(`<h${n}>${mdInline(esc(h[2]))}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); closeList(); out.push("<hr>"); i++; continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${mdInline(esc(line.replace(/^\s*[-*+]\s+/, "")))}</li>`);
      i++;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${mdInline(esc(line.replace(/^\s*\d+[.)]\s+/, "")))}</li>`);
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); closeList(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flushPara();
  closeList();
  return out.join("\n");
}

// Delegated clicks: lightbox thumbnails and row links (no inline handlers —
// artifact names and ids never end up inside executable attributes).
$app.addEventListener("click", (e) => {
  const refresh = e.target.closest("[data-refresh-status]");
  if (refresh) {
    refreshServiceStatus();
    return;
  }
  const img = e.target.closest("img[data-lightbox]");
  if (img) {
    openLightbox(img.src, img.alt);
    return;
  }
  const row = e.target.closest("tr[data-href]");
  if (row) location.hash = row.dataset.href;
});

// --- routes --------------------------------------------------------------

async function routeGallery() {
  $app.innerHTML = `
    <section class="hero">
      <div class="eyebrow">// COMPUTE · PARAMETRIC CAD</div>
      <h1>Agentic parametric CAD</h1>
      <p class="lead">An agent writes CadQuery code; kiln builds it in the
      cloud and verifies every part — watertight, bed-fit, support-free —
      then archives STLs, renders, and docs immutably per build.</p>
      <div class="cta-row">
        <a class="k-btn k-btn--primary" href="/llms.txt">Connect an agent</a>
        <a class="k-btn k-btn--ghost" href="https://github.com/cougz/kiln">View source</a>
      </div>
    </section>
    <section class="service-status service-status--checking" data-service-status></section>
    <form class="create-project" id="create-form">
      <input name="slug" placeholder="slug (lowercase-dashes)" required pattern="[a-z0-9][a-z0-9-]{1,63}">
      <input name="name" placeholder="name (optional)">
      <button class="k-btn k-btn--primary" type="submit">New project</button>
    </form>
    <div id="list">Loading projects…</div>
  `;
  document.getElementById("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const slug = f.get("slug").trim();
    try {
      await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, name: f.get("name")?.trim() || undefined }),
      }).then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || "create failed");
      });
      location.hash = `#/p/${slug}`;
    } catch (err) {
      alert(err.message);
    }
  });

  try {
    const projects = await api("/projects");
    const $list = document.getElementById("list");
    if (!projects.length) {
      $list.innerHTML = `<p class="empty">No projects yet — create one above, or connect an agent over MCP (see /llms.txt).</p>`;
      return;
    }
    $list.className = "card-grid";
    $list.innerHTML = projects.map((p) => `
      <a class="k-card card-link" href="#/p/${encodeURIComponent(p.slug)}">
        <h3>${esc(p.name)}</h3>
        <div class="slug">${esc(p.slug)} · created ${esc(fmtDate(p.created_at))}</div>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
      </a>
    `).join("");
  } catch (err) {
    document.getElementById("list").innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function routeProject(slug) {
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">projects</a> / ${esc(slug)}</div>
    <div id="detail">Loading…</div>
  `;
  const $d = document.getElementById("detail");
  try {
    const p = await api(`/projects/${encodeURIComponent(slug)}`);
    const sources = p.sources.map((s) =>
      `<li><code>${esc(s.path)}</code> <span class="slug">v${s.version}</span></li>`
    ).join("") || `<li class="empty">no sources</li>`;
    const docs = (p.docs || []).map((d) =>
      `<li><a href="#/p/${encodeURIComponent(slug)}/d/${encodeURIComponent(d.kind)}">${esc(d.kind)}</a>` +
      `${d.build_id ? ` <span class="slug">build ${esc(d.build_id)}</span>` : ""}</li>`
    ).join("") || `<li class="empty">no authored documents</li>`;

    const builds = p.recent_builds.length ? `
      <table>
        <tr><th>build</th><th>status</th><th>created</th></tr>
        ${p.recent_builds.map((b) => `
          <tr data-href="#/p/${encodeURIComponent(slug)}/b/${encodeURIComponent(b.id)}">
            <td><code>${esc(b.id)}</code></td>
            <td>${badge(b.status)}</td>
            <td>${esc(fmtDate(b.created_at))}</td>
          </tr>
        `).join("")}
      </table>
    ` : `<p class="empty">no builds yet</p>`;

    $d.innerHTML = `
      <h1 class="page-title">${esc(p.name)}</h1>
      ${p.description ? `<p class="lead">${esc(p.description)}</p>` : ""}
      <div class="k-card">
        <h3>Sources</h3>
        <ul class="artifact-list">${sources}</ul>
      </div>
      <div class="k-card">
        <h3>Builds</h3>
        ${builds}
      </div>
      <div class="k-card">
        <h3>Documents</h3>
        <ul class="artifact-list">${docs}</ul>
      </div>
    `;
  } catch (err) {
    $d.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function routeDoc(slug, kind) {
  $app.innerHTML = `
    <div class="crumbs">
      <a href="#/">projects</a> / <a href="#/p/${encodeURIComponent(slug)}">${esc(slug)}</a> / ${esc(kind)}
    </div>
    <div id="detail">Loading…</div>
  `;
  const $d = document.getElementById("detail");
  try {
    const doc = await api(`/projects/${encodeURIComponent(slug)}/docs/${encodeURIComponent(kind)}`);
    $d.innerHTML = `
      <h1 class="page-title">${esc(doc.kind)}</h1>
      <div class="slug">${doc.build_id ? `build ${esc(doc.build_id)} · ` : ""}updated ${esc(fmtDate(doc.updated_at))}</div>
      <div class="k-card doc"><div class="doc-body">${mdToHtml(doc.markdown)}</div></div>
    `;
  } catch (err) {
    $d.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function routeBuild(slug, buildId) {
  $app.innerHTML = `
    <div class="crumbs">
      <a href="#/">projects</a> / <a href="#/p/${encodeURIComponent(slug)}">${esc(slug)}</a> / ${esc(buildId)}
    </div>
    <div id="detail">Loading…</div>
  `;
  const $d = document.getElementById("detail");
  try {
    const b = await api(`/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}`);
    const inProgress = b.status === "queued" || b.status === "running";
    const report = b.report_json || {};
    const artifacts = report.artifacts || [];
    const images = artifacts.filter((a) => a.endsWith(".png"));
    const stls = artifacts.filter((a) => a.endsWith(".stl"));
    const docs = artifacts.filter((a) => a.endsWith(".md"));
    const other = artifacts.filter((a) => !images.includes(a) && !stls.includes(a) && !docs.includes(a));

    if (inProgress) {
      $d.innerHTML = `
        <h1 class="page-title">Build <code>${esc(buildId)}</code> ${badge(b.status)}</h1>
        <div class="slug">source v${b.source_version} · created ${esc(fmtDate(b.created_at))}</div>
        <div class="k-card">
          <h3>Build in progress</h3>
          <p class="empty">The engine is running this build (typically 1–5 min).
          This page refreshes automatically.</p>
        </div>
      `;
      pollTimer = setTimeout(() => routeBuild(slug, buildId), 8000);
      return;
    }

    $d.innerHTML = `
      <h1 class="page-title">Build <code>${esc(buildId)}</code> ${badge(b.status)}</h1>
      <div class="slug">source v${b.source_version} · created ${esc(fmtDate(b.created_at))}${b.finished_at ? " · finished " + esc(fmtDate(b.finished_at)) : ""}</div>
      ${images.length ? `
        <div class="k-card">
          <h3>Renders</h3>
          <div class="renders">
            ${images.map((p) => renderThumb(artifactUrl(slug, buildId, p), p)).join("")}
          </div>
        </div>
      ` : ""}
      <div class="k-card">
        <h3>Artifacts</h3>
        ${artifacts.length ? `<ul class="artifact-list">${
          [...stls, ...other, ...images].map((p) => `
            <li><code>${esc(p)}</code> <a class="k-btn k-btn--ghost k-btn--sm" href="${artifactUrl(slug, buildId, p)}" download>download</a></li>
          `).join("")
        }</ul>` : `<p class="empty">no artifacts</p>`}
      </div>
      ${docs.map((p) => `<div class="k-card doc" data-path="${esc(p)}"><h3>${esc(p)}</h3><div class="doc-body"><p class="empty">loading…</p></div></div>`).join("")}
      <div class="k-card">
        <h3>Verification report</h3>
        <pre>${esc(JSON.stringify(report, null, 2))}</pre>
      </div>
    `;

    for (const el of $d.querySelectorAll(".doc")) {
      const path = el.dataset.path;
      fetch(artifactUrl(slug, buildId, path))
        .then((r) => r.text())
        .then((text) => { el.querySelector(".doc-body").innerHTML = mdToHtml(text); })
        .catch((err) => { el.querySelector(".doc-body").innerHTML = `<p class="error">${esc(err.message)}</p>`; });
    }
  } catch (err) {
    $d.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// --- router ---------------------------------------------------------------

let pollTimer = null;

function route() {
  clearTimeout(pollTimer);
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1] && parts[2] === "b" && parts[3]) {
    routeBuild(decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
  } else if (parts[0] === "p" && parts[1] && parts[2] === "d" && parts[3]) {
    routeDoc(decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
  } else if (parts[0] === "p" && parts[1]) {
    routeProject(decodeURIComponent(parts[1]));
  } else {
    routeGallery();
  }
}

window.addEventListener("hashchange", route);
route();

$status.addEventListener("click", () => {
  if (!location.hash || location.hash === "#/") {
    $app.querySelector("[data-service-status]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    location.hash = "#/";
  }
});
setInterval(refreshServiceStatus, 30_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshServiceStatus();
});
refreshServiceStatus();
