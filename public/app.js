// kiln frontend - dependency-free hash router over the REST API.

const $app = document.getElementById("app");
const $status = document.getElementById("status");
const $apiKey = document.getElementById("api-key");
const $apiKeyStatus = document.getElementById("api-key-status");
const $clearApiKey = document.getElementById("clear-api-key");

const API_KEY_STORAGE = "kiln.apiKey";
const DOC_KINDS = ["specification", "instructions", "bom", "page"];
const POLL_DELAYS = [3000, 5000, 8000, 13000, 21000, 30000];
const MAX_MARKDOWN_PREVIEWS = 8;
const MAX_MARKDOWN_PREVIEW_BYTES = 256 * 1024;
const MARKDOWN_PREVIEW_CONCURRENCY = 3;
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const STARTER_SOURCE = `import cadquery as cq
import json
import os

with open("params.json", encoding="utf-8") as handle:
    params = json.load(handle)

box = cq.Workplane("XY").box(
    params["width"], params["depth"], params["height"],
    centered=(False, False, False),
)

os.makedirs("stl", exist_ok=True)
os.makedirs("asm", exist_ok=True)
cq.exporters.export(box, "stl/box.stl")
cq.exporters.export(box, "asm/box.stl")
`;
const STARTER_PARAMS = { width: 40, depth: 30, height: 12 };

let serviceStatus = { state: "checking", health: null, checkedAt: null };
let serviceRequest = 0;
let routeGeneration = 0;
let routeController = null;
let pollTimer = null;
let pendingPoll = null;
let routeNotice = "";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);

function getApiKey() {
  try {
    return sessionStorage.getItem(API_KEY_STORAGE) || "";
  } catch {
    return $apiKey.value || "";
  }
}

function setApiKey(value) {
  const key = value.trim();
  try {
    if (key) sessionStorage.setItem(API_KEY_STORAGE, key);
    else sessionStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // Storage can be unavailable in hardened browsers; the input still lasts
    // for the life of this page.
  }
  $apiKeyStatus.textContent = key
    ? "API key saved for this tab. Protected writes are enabled."
    : "API key cleared. Public read access remains available.";
  document.body.classList.toggle("has-api-key", Boolean(key));
}

$apiKey.value = getApiKey();
document.body.classList.toggle("has-api-key", Boolean($apiKey.value));
$apiKey.addEventListener("input", () => setApiKey($apiKey.value));
$clearApiKey.addEventListener("click", () => {
  $apiKey.value = "";
  setApiKey("");
  $apiKey.focus();
});

class ApiRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function request(path, options = {}) {
  const { write = false, responseType = "json", ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  if (write) {
    const key = getApiKey();
    if (!key) throw new ApiRequestError("Add an API key above before making protected changes.", 401);
    headers.set("Authorization", `Bearer ${key}`);
  }
  const response = await fetch(`/api${path}`, { ...fetchOptions, headers });
  const text = await response.text();
  let body = text;
  if (responseType === "json") {
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      if (response.ok) throw new ApiRequestError("The API returned invalid JSON.", response.status);
      body = {};
    }
  }
  if (!response.ok) {
    const detail = typeof body === "object" && body?.error ? body.error : text;
    throw new ApiRequestError(detail || `${response.status} ${response.statusText}`, response.status);
  }
  return body;
}

const api = (path, options = {}) => request(path, options);

function writeApi(path, method, body, signal) {
  return request(path, {
    method,
    write: true,
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function sourcePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function artifactUrl(slug, buildId, path) {
  const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
  return `/api/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}/artifacts/${encodedPath}`;
}

function routeHref(slug, suffix = "") {
  return `#/p/${encodeURIComponent(slug)}${suffix}`;
}

function fmtDate(value) {
  if (!value) return "";
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(value) ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return isNaN(date)
    ? String(value)
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
}

function fmtBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function badge(status) {
  const label = status === "verified" ? "preflight passed" : status || "unknown";
  return `<span class="k-tag ${esc(status)}">${esc(label)}</span>`;
}

function errorMarkup(error) {
  return `<div class="message message--error" role="alert">${esc(error?.message || error)}</div>`;
}

function setMessage(element, message = "", isError = false) {
  element.className = `form-message${isError ? " error" : ""}`;
  element.textContent = message;
}

function setBusy(button, busy, busyLabel = "Saving...") {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function isCurrent(context) {
  return context.generation === routeGeneration && !context.signal.aborted;
}

function isAbort(error) {
  return error?.name === "AbortError";
}

// --- service status ---------------------------------------------------------

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
        { name: "D1 metadata", value: health.d1, ready: "ready", unavailable: "unavailable" },
        { name: "R2 archive", value: health.r2, ready: "ready", unavailable: "unavailable" },
        { name: "Build workflow", value: health.workflow_configured, ready: "configured", unavailable: "not configured" },
        { name: "Write authorization", value: health.write_auth_configured, ready: "configured", unavailable: "not configured" },
        ...(health.engine ? [{ name: "CAD engine", value: health.engine.ok, ready: "ready", unavailable: "unavailable" }] : []),
      ]
    : [{ name: "Service check", value: null, ready: "ready", unavailable: "unavailable" }];
  const message = state === "operational"
    ? `Metadata, archive storage, and build workflow are ready.${health?.write_auth_configured ? " Protected writes are configured." : " Protected writes are not configured on this deployment."}`
    : state === "degraded"
      ? "Some dependencies are unavailable. New builds or artifact retrieval may fail."
      : state === "offline"
        ? "The API could not be reached. Existing pages may show cached information."
        : "Verifying the Worker and its storage bindings.";
  panel.className = `service-status service-status--${state}`;
  panel.innerHTML = `
    <div class="service-status__heading">
      <div><div class="eyebrow">// SERVICE STATUS</div><h2>${esc(statusLabel())}</h2></div>
      <button class="k-btn k-btn--ghost k-btn--sm" type="button" data-refresh-status>Refresh</button>
    </div>
    <p>${esc(message)}</p>
    <div class="service-status__meta">
      ${dependencies.map((dependency) => `
        <span class="service-check ${dependency.value === true ? "is-up" : dependency.value === false ? "is-down" : "is-checking"}">
          <span aria-hidden="true"></span>${esc(dependency.name)}: ${dependency.value === true ? dependency.ready : dependency.value === false ? dependency.unavailable : "checking"}
        </span>`).join("")}
    </div>
    <div class="service-status__foot">${health?.phase ? `phase ${esc(health.phase)} · ` : ""}${checkedAt ? `checked ${esc(fmtDate(checkedAt))}` : "awaiting response"}</div>
  `;
}

async function refreshServiceStatus() {
  const requestId = ++serviceRequest;
  serviceStatus = { ...serviceStatus, state: "checking" };
  renderServiceStatus();
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const health = await response.json();
    if (!health || typeof health !== "object") throw new Error("invalid health response");
    if (requestId !== serviceRequest) return;
    serviceStatus = {
      state: response.ok && health.ok ? "operational" : "degraded",
      health,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    if (requestId !== serviceRequest) return;
    serviceStatus = { state: "offline", health: null, checkedAt: new Date().toISOString() };
  }
  renderServiceStatus();
}

// WebMCP is a read-only progressive enhancement. It never receives the API key.
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

// --- accessible render lightbox --------------------------------------------

let $lightbox = null;
let lightboxOpener = null;

function ensureLightbox() {
  if ($lightbox) return $lightbox;
  $lightbox = document.createElement("dialog");
  $lightbox.className = "lightbox";
  $lightbox.setAttribute("aria-labelledby", "lightbox-title");
  $lightbox.setAttribute("aria-describedby", "lightbox-hint");
  $lightbox.innerHTML = `
    <h2 class="sr-only" id="lightbox-title">Build render preview</h2>
    <button class="lightbox-close" type="button" aria-label="Close render preview">&times;</button>
    <button class="lightbox-image-button" type="button" aria-label="Toggle full-size zoom">
      <img class="lightbox-img" alt="">
    </button>
    <div class="lightbox-hint" id="lightbox-hint">Select image to zoom · Escape to close</div>
  `;
  document.body.appendChild($lightbox);

  const image = $lightbox.querySelector(".lightbox-img");
  $lightbox.querySelector(".lightbox-close").addEventListener("click", () => $lightbox.close());
  $lightbox.querySelector(".lightbox-image-button").addEventListener("click", (event) => {
    if (image.classList.contains("zoomed")) {
      image.classList.remove("zoomed");
      return;
    }
    const bounds = image.getBoundingClientRect();
    const x = event.detail && bounds.width ? ((event.clientX - bounds.left) / bounds.width) * 100 : 50;
    const y = event.detail && bounds.height ? ((event.clientY - bounds.top) / bounds.height) * 100 : 50;
    image.style.transformOrigin = `${Math.max(0, Math.min(100, x))}% ${Math.max(0, Math.min(100, y))}%`;
    image.classList.add("zoomed");
  });
  $lightbox.addEventListener("click", (event) => {
    if (event.target === $lightbox) $lightbox.close();
  });
  $lightbox.addEventListener("close", () => {
    image.classList.remove("zoomed");
    if (lightboxOpener?.isConnected) lightboxOpener.focus({ preventScroll: true });
    lightboxOpener = null;
  });
  return $lightbox;
}

function openLightbox(src, alt, opener) {
  const dialog = ensureLightbox();
  const image = dialog.querySelector(".lightbox-img");
  lightboxOpener = opener;
  image.classList.remove("zoomed");
  image.src = src;
  image.alt = alt || "Build render";
  if (!dialog.open) dialog.showModal();
  dialog.querySelector(".lightbox-close").focus();
}

function renderThumb(src, alt) {
  return `
    <button class="render-thumb" type="button" data-lightbox data-src="${esc(src)}" aria-label="Open ${esc(alt)} in image viewer">
      <img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">
    </button>`;
}

// --- conservative Markdown rendering ---------------------------------------

function mdInline(value) {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, href) =>
      /^(https?:\/\/|\/|#|\.)/.test(href) ? `<a href="${href}" rel="noopener">${text}</a>` : match);
}

function mdToHtml(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const output = [];
  let index = 0;
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${mdInline(esc(paragraph.join(" ")))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      flushParagraph();
      closeList();
      const buffer = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index])) buffer.push(lines[index++]);
      index++;
      output.push(`<pre>${esc(buffer.join("\n"))}</pre>`);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]) && lines[index + 1].includes("-")) {
      flushParagraph();
      closeList();
      const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
        .split("|").map((cell) => mdInline(esc(cell.trim())));
      const heading = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|")) rows.push(cells(lines[index++]));
      output.push(`<table><tr>${heading.map((cell) => `<th>${cell}</th>`).join("")}</tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 3, 6);
      output.push(`<h${level}>${mdInline(esc(heading[2]))}</h${level}>`);
      index++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph(); closeList(); output.push("<hr>"); index++; continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      if (list !== "ul") { closeList(); output.push("<ul>"); list = "ul"; }
      output.push(`<li>${mdInline(esc(line.replace(/^\s*[-*+]\s+/, "")))}</li>`);
      index++;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      if (list !== "ol") { closeList(); output.push("<ol>"); list = "ol"; }
      output.push(`<li>${mdInline(esc(line.replace(/^\s*\d+[.)]\s+/, "")))}</li>`);
      index++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph(); closeList(); index++; continue;
    }
    paragraph.push(line.trim());
    index++;
  }
  flushParagraph();
  closeList();
  return output.join("\n");
}

// --- shared interaction -----------------------------------------------------

$app.addEventListener("click", (event) => {
  const refresh = event.target.closest("[data-refresh-status]");
  if (refresh) {
    refreshServiceStatus();
    return;
  }
  const thumbnail = event.target.closest("[data-lightbox]");
  if (thumbnail) {
    const image = thumbnail.querySelector("img");
    openLightbox(thumbnail.dataset.src, image?.alt, thumbnail);
    return;
  }
  const row = event.target.closest("tr[data-href]");
  if (row && !event.target.closest("a, button, input, select, textarea")) location.hash = row.dataset.href;
});

$app.addEventListener("keydown", (event) => {
  const row = event.target.closest("tr[data-href]");
  if (!row || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  location.hash = row.dataset.href;
});

// --- gallery ---------------------------------------------------------------

async function routeGallery(context) {
  $app.innerHTML = `
    <section class="hero">
      <div class="eyebrow">// COMPUTE · PARAMETRIC CAD</div>
      <h1>Agentic parametric CAD</h1>
      <p class="lead">An agent writes CadQuery code; kiln runs bounded geometry preflight in the cloud, then archives STLs, renders, reports, and docs immutably per build.</p>
      <div class="cta-row">
        <a class="k-btn k-btn--primary" href="/llms.txt">Connect an agent</a>
        <a class="k-btn k-btn--ghost" href="https://github.com/cougz/kiln">View source</a>
      </div>
    </section>
    <section class="service-status service-status--checking" data-service-status aria-live="polite"></section>
    <section class="k-card onboarding" aria-labelledby="create-heading">
      <div class="section-heading">
        <div>
          <div class="eyebrow">// PROTECTED WRITE</div>
          <h2 id="create-heading">Create a project</h2>
        </div>
        <span class="access-chip">API key required</span>
      </div>
      <p class="section-intro">Start empty or install a small parameterized CadQuery box so the source, parameters, and build workflow are immediately ready to explore.</p>
      <form id="create-form">
        <div class="form-grid">
          <label class="field">
            <span>Project slug <small>lowercase letters, numbers, dashes</small></span>
            <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,63}" autocomplete="off" placeholder="desk-organizer">
          </label>
          <label class="field">
            <span>Project name <small>optional</small></span>
            <input name="name" autocomplete="off" placeholder="Desk organizer">
          </label>
          <label class="field field--wide">
            <span>Description <small>optional, publicly visible</small></span>
            <textarea name="description" rows="3" placeholder="What this project makes and why"></textarea>
          </label>
        </div>
        <label class="check-field">
          <input name="template" type="checkbox" checked>
          <span><strong>Add the CadQuery box starter</strong><small>Creates <code>build.py</code> and versioned dimensions in <code>params.json</code>.</small></span>
        </label>
        <details class="template-preview">
          <summary>Preview starter parameters</summary>
          <pre>${esc(JSON.stringify(STARTER_PARAMS, null, 2))}</pre>
        </details>
        <div class="form-actions">
          <button class="k-btn k-btn--primary" type="submit">Create project</button>
          <span class="form-message" id="create-message" role="status" aria-live="polite"></span>
        </div>
      </form>
    </section>
    <section aria-labelledby="projects-heading">
      <div class="section-heading"><h2 id="projects-heading">Public projects</h2><span class="access-chip access-chip--public">No key required</span></div>
      <div id="project-list" aria-live="polite">Loading projects...</div>
    </section>
  `;
  renderServiceStatus();

  const form = $app.querySelector("#create-form");
  const message = $app.querySelector("#create-message");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const slug = String(data.get("slug") || "").trim();
    const button = form.querySelector("button[type=submit]");
    setBusy(button, true, "Creating...");
    setMessage(message, "Creating protected project...");
    try {
      await writeApi("/projects", "POST", {
        slug,
        name: String(data.get("name") || "").trim() || undefined,
        description: String(data.get("description") || "").trim() || undefined,
      }, context.signal);
      if (data.get("template")) {
        setMessage(message, "Installing starter source and parameters...");
        try {
          await writeApi(`/projects/${encodeURIComponent(slug)}/source`, "PUT", { path: "build.py", content: STARTER_SOURCE }, context.signal);
          await writeApi(`/projects/${encodeURIComponent(slug)}/params`, "PUT", { params: STARTER_PARAMS }, context.signal);
        } catch (error) {
          if (isAbort(error)) return;
          routeNotice = `Project created, but the starter was only partially installed: ${error.message}`;
          location.hash = routeHref(slug);
          return;
        }
      }
      location.hash = routeHref(slug);
    } catch (error) {
      if (!isAbort(error)) setMessage(message, error.message, true);
      setBusy(button, false);
    }
  });

  try {
    const projects = await api("/projects", { signal: context.signal });
    if (!isCurrent(context)) return;
    const list = $app.querySelector("#project-list");
    if (!projects.length) {
      list.innerHTML = `<p class="empty">No projects yet. Add an API key and create one above, or connect an agent over MCP.</p>`;
      return;
    }
    list.className = "card-grid";
    list.innerHTML = projects.map((project) => `
      <a class="k-card card-link" href="${routeHref(project.slug)}">
        <h3>${esc(project.name)}</h3>
        <div class="slug">${esc(project.slug)} · created ${esc(fmtDate(project.created_at))}</div>
        ${project.description ? `<p class="desc">${esc(project.description)}</p>` : ""}
      </a>`).join("");
  } catch (error) {
    if (isAbort(error) || !isCurrent(context)) return;
    $app.querySelector("#project-list").innerHTML = errorMarkup(error);
  }
}

// --- project workspace ------------------------------------------------------

function buildRows(builds, slug) {
  if (!builds?.length) return `<p class="empty">No builds yet. Configure a source and queue the first build below.</p>`;
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>build</th><th>status</th><th>created</th></tr></thead>
        <tbody>${builds.map((build) => {
          const href = routeHref(slug, `/b/${encodeURIComponent(build.id)}`);
          return `<tr data-href="${href}" tabindex="0" role="link" aria-label="Open build ${esc(build.id)}, ${esc(build.status)}">
            <td><a href="${href}"><code>${esc(build.id)}</code></a></td>
            <td>${badge(build.status)}</td>
            <td>${esc(fmtDate(build.created_at))}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
}

async function routeProject(slug, context) {
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">projects</a> / ${esc(slug)}</div>
    <div id="detail" aria-live="polite">Loading project...</div>
  `;
  const detail = $app.querySelector("#detail");
  try {
    const [project, parameterData] = await Promise.all([
      api(`/projects/${encodeURIComponent(slug)}`, { signal: context.signal }),
      api(`/projects/${encodeURIComponent(slug)}/params`, { signal: context.signal }),
    ]);
    if (!isCurrent(context)) return;
    const sources = (project.sources || []).filter((source) => source.path !== "params.json");
    const selectedSource = sources[0]?.path || "";
    const sourceOptions = sources.map((source) => `<option value="${esc(source.path)}">${esc(source.path)} · v${esc(source.version)}</option>`).join("");
    const docsByKind = new Map((project.docs || []).map((doc) => [doc.kind, doc]));
    const notice = routeNotice;
    routeNotice = "";

    detail.innerHTML = `
      <header class="page-header">
        <div>
          <div class="eyebrow">// PUBLIC PROJECT · PROTECTED EDITING</div>
          <h1 class="page-title">${esc(project.name)}</h1>
          ${project.description ? `<p class="lead">${esc(project.description)}</p>` : ""}
        </div>
      </header>

      ${notice ? `<div class="message message--error" role="alert">${esc(notice)}</div>` : ""}

      <details class="k-card metadata-editor">
        <summary>Edit public project metadata</summary>
        <form id="project-metadata-form">
          <div class="form-grid">
            <label class="field">
              <span>Project name</span>
              <input name="name" required maxlength="160" value="${esc(project.name)}">
            </label>
            <label class="field field--wide">
              <span>Description</span>
              <textarea name="description" rows="3" maxlength="2000">${esc(project.description || "")}</textarea>
            </label>
          </div>
          <div class="form-actions">
            <button class="k-btn k-btn--primary" type="submit">Save metadata</button>
            <span class="form-message" id="project-metadata-state" role="status" aria-live="polite"></span>
          </div>
        </form>
      </details>

      <section class="k-card workspace-card" aria-labelledby="source-heading">
        <div class="section-heading">
          <div><h2 id="source-heading">Project source</h2><p>Read the latest public revision or save a new protected version.</p></div>
          <span class="access-chip">Writes need key</span>
        </div>
        <div class="source-toolbar">
          <label class="field">
            <span>Source file</span>
            <select id="source-select">
              ${sourceOptions}
              <option value="">+ New source file</option>
            </select>
          </label>
          <label class="field">
            <span>Revision</span>
            <select id="source-version" disabled><option value="">Loading history...</option></select>
          </label>
          <label class="field source-new-path" ${selectedSource ? "hidden" : ""}>
            <span>New file path</span>
            <input id="source-new-path" placeholder="build.py" autocomplete="off" ${selectedSource ? "disabled" : ""}>
          </label>
        </div>
        <p class="field-help">Select one of the latest 100 immutable revisions. Editing an older revision and saving creates a new head version; existing revisions never change.</p>
        <label class="field editor-field">
          <span>CadQuery / Python source</span>
          <textarea id="source-content" class="code-editor" rows="22" spellcheck="false" aria-describedby="source-state">${selectedSource ? "Loading latest source..." : ""}</textarea>
        </label>
        <div class="form-actions">
          <button class="k-btn k-btn--primary" id="save-source" type="button">Save new version</button>
          <span class="form-message" id="source-state" role="status" aria-live="polite"></span>
        </div>
      </section>

      <div class="workspace-grid">
        <section class="k-card" aria-labelledby="params-heading">
          <div class="section-heading">
            <div><h2 id="params-heading">Parameters</h2><p>Versioned as <code>params.json</code> and pinned into each build.</p></div>
            <span class="version-chip">v${esc(parameterData.version)}</span>
          </div>
          <label class="field editor-field">
            <span>Parameters JSON</span>
            <textarea id="params-content" class="code-editor code-editor--short" rows="14" spellcheck="false">${esc(JSON.stringify(parameterData.params, null, 2))}</textarea>
          </label>
          <div class="form-actions">
            <button class="k-btn k-btn--primary" id="save-params" type="button">Save parameters</button>
            <span class="form-message" id="params-state" role="status" aria-live="polite"></span>
          </div>
        </section>

        <section class="k-card" aria-labelledby="build-heading">
          <div class="section-heading">
            <div><h2 id="build-heading">Queue a build</h2><p>The exact source and parameters are pinned when queued.</p></div>
            <span class="access-chip">Protected</span>
          </div>
          <form id="build-form">
            <label class="field">
              <span>Entry source</span>
              <input name="entry" list="source-path-list" required value="${esc(sources.some((source) => source.path === "build.py") ? "build.py" : selectedSource)}" placeholder="build.py">
              <datalist id="source-path-list">${sources.map((source) => `<option value="${esc(source.path)}"></option>`).join("")}</datalist>
            </label>
            <label class="field">
              <span>Timeout <small>seconds, 30-900</small></span>
              <input name="timeout" type="number" min="30" max="900" step="1" value="600" required>
            </label>
            <fieldset class="dimension-fields">
              <legend>Printer dimensions <small>millimeters</small></legend>
              <label><span>X</span><input name="printer_x" type="number" min="1" step="0.1" value="180" required></label>
              <label><span>Y</span><input name="printer_y" type="number" min="1" step="0.1" value="180" required></label>
              <label><span>Z</span><input name="printer_z" type="number" min="1" step="0.1" value="180" required></label>
            </fieldset>
            <div class="form-actions">
              <button class="k-btn k-btn--primary" type="submit">Queue build</button>
              <span class="form-message" id="build-state" role="status" aria-live="polite"></span>
            </div>
          </form>
        </section>
      </div>

      <section class="k-card" aria-labelledby="builds-heading">
        <div class="section-heading"><h2 id="builds-heading">Build history</h2><span class="access-chip access-chip--public">Public read</span></div>
        ${buildRows(project.recent_builds, slug)}
      </section>

      <section class="k-card" aria-labelledby="docs-heading">
        <div class="section-heading"><div><h2 id="docs-heading">Authored documents</h2><p>Public Markdown with a protected editor for each supported document.</p></div></div>
        <div class="doc-links">
          ${DOC_KINDS.map((kind) => {
            const doc = docsByKind.get(kind);
            return `<a class="doc-link" href="${routeHref(slug, `/d/${encodeURIComponent(kind)}`)}">
              <span><strong>${esc(kind)}</strong><small>${doc ? `Updated ${esc(fmtDate(doc.updated_at))}` : "Not authored yet"}</small></span>
              <span aria-hidden="true">→</span>
            </a>`;
          }).join("")}
        </div>
      </section>
    `;

    bindProjectMetadata(slug, context);
    bindProjectSource(slug, selectedSource, context);
    bindParams(slug, parameterData, context);
    bindBuildForm(slug, context);
  } catch (error) {
    if (isAbort(error) || !isCurrent(context)) return;
    detail.innerHTML = errorMarkup(error);
  }
}

function bindProjectMetadata(slug, context) {
  const form = $app.querySelector("#project-metadata-form");
  const state = $app.querySelector("#project-metadata-state");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const button = form.querySelector("button[type=submit]");
    setBusy(button, true);
    setMessage(state, "Saving public project metadata...");
    try {
      const project = await writeApi(`/projects/${encodeURIComponent(slug)}`, "PATCH", {
        name: String(data.get("name") || "").trim(),
        description: String(data.get("description") || "").trim(),
      }, context.signal);
      if (!isCurrent(context)) return;
      $app.querySelector(".page-title").textContent = project.name;
      setMessage(state, "Project metadata saved.");
    } catch (error) {
      if (!isAbort(error)) setMessage(state, error.message, true);
    } finally {
      setBusy(button, false);
    }
  });
}

function bindProjectSource(slug, selectedSource, context) {
  const select = $app.querySelector("#source-select");
  const versionSelect = $app.querySelector("#source-version");
  const pathField = $app.querySelector(".source-new-path");
  const pathInput = $app.querySelector("#source-new-path");
  const editor = $app.querySelector("#source-content");
  const state = $app.querySelector("#source-state");
  const save = $app.querySelector("#save-source");
  let sourceController = null;
  let latestVersion = null;
  const sourceCache = new Map();

  context.signal.addEventListener("abort", () => sourceController?.abort(), { once: true });

  function controllerForRequest() {
    sourceController?.abort();
    sourceController = new AbortController();
    if (context.signal.aborted) sourceController.abort();
    return sourceController;
  }

  function showSource(path, source) {
    sourceCache.set(source.version, source);
    editor.value = source.content;
    editor.disabled = false;
    setMessage(state, source.version === latestVersion
      ? `Viewing latest ${path} version ${source.version}.`
      : `Viewing immutable ${path} version ${source.version}. Saving this content creates a new version.`);
  }

  async function loadPath(path) {
    const controller = controllerForRequest();
    sourceCache.clear();
    latestVersion = null;
    if (!path) {
      pathField.hidden = false;
      pathInput.disabled = false;
      pathInput.focus();
      editor.value = "";
      editor.disabled = false;
      versionSelect.disabled = true;
      versionSelect.innerHTML = "<option value=\"\">New file · no revisions</option>";
      setMessage(state, "Choose a safe relative path, then save the first version.");
      return;
    }
    pathField.hidden = true;
    pathInput.disabled = true;
    editor.disabled = true;
    editor.value = "Loading latest source...";
    versionSelect.disabled = true;
    versionSelect.innerHTML = "<option value=\"\">Loading history...</option>";
    setMessage(state, `Loading ${path}...`);
    try {
      const sourceUrl = `/projects/${encodeURIComponent(slug)}/source/${sourcePath(path)}`;
      const [source, history] = await Promise.all([
        api(sourceUrl, { signal: controller.signal }),
        api(`${sourceUrl}?history=1&limit=100`, { signal: controller.signal }),
      ]);
      if (!isCurrent(context) || select.value !== path) return;
      if (!Array.isArray(history.versions)) throw new ApiRequestError("Source history has an invalid shape.", 502);
      latestVersion = source.version;
      sourceCache.set(source.version, source);
      versionSelect.innerHTML = history.versions.map((revision) => `
        <option value="${esc(revision.version)}" ${revision.version === source.version ? "selected" : ""}>v${esc(revision.version)}${revision.version === source.version ? " · latest" : ""} · ${esc(fmtDate(revision.created_at))} · ${esc(fmtBytes(revision.size))}</option>`).join("");
      versionSelect.disabled = history.versions.length < 2;
      showSource(path, source);
      if (history.cursor) setMessage(state, `Viewing latest ${path} version ${source.version}. Showing the latest 100 revisions.`);
    } catch (error) {
      if (!isAbort(error)) {
        editor.value = "";
        versionSelect.innerHTML = "<option value=\"\">History unavailable</option>";
        versionSelect.disabled = true;
        setMessage(state, error.message, true);
      }
    } finally {
      if (isCurrent(context) && select.value === path) editor.disabled = false;
    }
  }

  async function loadVersion(path, version) {
    if (!path || !Number.isSafeInteger(version) || version < 1) return;
    const cached = sourceCache.get(version);
    if (cached) {
      showSource(path, cached);
      return;
    }
    const controller = controllerForRequest();
    editor.disabled = true;
    setMessage(state, `Loading ${path} version ${version}...`);
    try {
      const source = await api(`/projects/${encodeURIComponent(slug)}/source/${sourcePath(path)}?version=${encodeURIComponent(version)}`, { signal: controller.signal });
      if (!isCurrent(context) || select.value !== path || Number(versionSelect.value) !== version) return;
      showSource(path, source);
    } catch (error) {
      if (!isAbort(error)) setMessage(state, error.message, true);
    } finally {
      if (isCurrent(context) && select.value === path) editor.disabled = false;
    }
  }

  select.addEventListener("change", () => loadPath(select.value));
  versionSelect.addEventListener("change", () => loadVersion(select.value, Number(versionSelect.value)));
  save.addEventListener("click", async () => {
    const path = select.value || pathInput.value.trim();
    if (!path) {
      setMessage(state, "Enter a source file path.", true);
      pathInput.focus();
      return;
    }
    setBusy(save, true);
    setMessage(state, `Saving a new version of ${path}...`);
    try {
      const result = await writeApi(`/projects/${encodeURIComponent(slug)}/source`, "PUT", { path, content: editor.value }, context.signal);
      if (!isCurrent(context)) return;
      if (!select.value) {
        const option = document.createElement("option");
        option.value = path;
        option.textContent = `${path} · v${result.version}`;
        select.insertBefore(option, select.lastElementChild);
        select.value = path;
        pathField.hidden = true;
        pathInput.disabled = true;
      } else {
        select.selectedOptions[0].textContent = `${path} · v${result.version}`;
      }
      await loadPath(path);
      if (isCurrent(context)) setMessage(state, `${path} version ${result.version} saved and selected.`);
    } catch (error) {
      if (!isAbort(error)) setMessage(state, error.message, true);
    } finally {
      setBusy(save, false);
    }
  });
  if (selectedSource) loadPath(selectedSource);
  else {
    versionSelect.innerHTML = "<option value=\"\">New file · no revisions</option>";
    setMessage(state, "Choose a safe relative path, then save the first version.");
  }
}

function bindParams(slug, parameterData, context) {
  const editor = $app.querySelector("#params-content");
  const save = $app.querySelector("#save-params");
  const state = $app.querySelector("#params-state");
  save.addEventListener("click", async () => {
    let params;
    try {
      params = JSON.parse(editor.value);
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Parameters must be a JSON object.");
    } catch (error) {
      setMessage(state, error.message || "Parameters contain invalid JSON.", true);
      editor.focus();
      return;
    }
    setBusy(save, true);
    setMessage(state, "Saving versioned parameters...");
    try {
      const result = await writeApi(`/projects/${encodeURIComponent(slug)}/params`, "PUT", { params }, context.signal);
      if (!isCurrent(context)) return;
      editor.value = JSON.stringify(result.params, null, 2);
      $app.querySelector("#params-heading").closest(".section-heading").querySelector(".version-chip").textContent = `v${result.version}`;
      setMessage(state, `Parameters version ${result.version} saved.`);
    } catch (error) {
      if (!isAbort(error)) setMessage(state, error.message, true);
    } finally {
      setBusy(save, false);
    }
  });
}

function bindBuildForm(slug, context) {
  const form = $app.querySelector("#build-form");
  const state = $app.querySelector("#build-state");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const button = form.querySelector("button[type=submit]");
    const body = {
      entry: String(data.get("entry") || "").trim(),
      timeout_s: Number(data.get("timeout")),
      printer_profile: {
        x: Number(data.get("printer_x")),
        y: Number(data.get("printer_y")),
        z: Number(data.get("printer_z")),
      },
    };
    setBusy(button, true, "Queueing...");
    setMessage(state, "Pinning the current project and queueing build...");
    try {
      const result = await writeApi(`/projects/${encodeURIComponent(slug)}/builds`, "POST", body, context.signal);
      location.hash = routeHref(slug, `/b/${encodeURIComponent(result.build_id)}`);
    } catch (error) {
      if (!isAbort(error)) setMessage(state, error.message, true);
      setBusy(button, false);
    }
  });
}

// --- authored documents -----------------------------------------------------

async function routeDoc(slug, kind, context) {
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">projects</a> / <a href="${routeHref(slug)}">${esc(slug)}</a> / ${esc(kind)}</div>
    <div id="detail" aria-live="polite">Loading document...</div>
  `;
  const detail = $app.querySelector("#detail");
  let doc = null;
  try {
    doc = await api(`/projects/${encodeURIComponent(slug)}/docs/${encodeURIComponent(kind)}`, { signal: context.signal });
  } catch (error) {
    if (isAbort(error) || !isCurrent(context)) return;
    if (error.status !== 404) {
      detail.innerHTML = errorMarkup(error);
      return;
    }
  }
  if (!isCurrent(context)) return;
  const markdown = doc?.markdown || `# ${kind[0]?.toUpperCase()}${kind.slice(1)}\n\n`;
  detail.innerHTML = `
    <header class="page-header">
      <div class="eyebrow">// AUTHORED DOCUMENT · PUBLIC READ / PROTECTED WRITE</div>
      <h1 class="page-title">${esc(kind)}</h1>
      <div class="slug">${doc ? `${doc.build_id ? `build ${esc(doc.build_id)} · ` : ""}updated ${esc(fmtDate(doc.updated_at))}` : "Not authored yet"}</div>
    </header>
    <section class="k-card">
      <div class="editor-layout">
        <div>
          <label class="field editor-field">
            <span>Markdown</span>
            <textarea id="doc-markdown" class="code-editor doc-editor" rows="26" spellcheck="true">${esc(markdown)}</textarea>
          </label>
          <label class="field">
            <span>Associated build ID <small>optional</small></span>
            <input id="doc-build-id" value="${esc(doc?.build_id || "")}" autocomplete="off" placeholder="Build ID">
          </label>
          <div class="form-actions">
            <button class="k-btn k-btn--primary" id="save-doc" type="button">${doc ? "Save document" : "Publish document"}</button>
            <span class="form-message" id="doc-state" role="status" aria-live="polite"></span>
          </div>
        </div>
        <div class="doc-preview-panel">
          <h2>Preview</h2>
          <div class="doc-body" id="doc-preview"></div>
        </div>
      </div>
    </section>
  `;
  const editor = $app.querySelector("#doc-markdown");
  const preview = $app.querySelector("#doc-preview");
  const save = $app.querySelector("#save-doc");
  const state = $app.querySelector("#doc-state");
  const updatePreview = () => {
    preview.innerHTML = editor.value.trim() ? mdToHtml(editor.value) : `<p class="empty">Nothing to preview.</p>`;
  };
  updatePreview();
  editor.addEventListener("input", updatePreview);
  save.addEventListener("click", async () => {
    const buildId = $app.querySelector("#doc-build-id").value.trim();
    setBusy(save, true);
    setMessage(state, "Saving protected Markdown...");
    try {
      const result = await writeApi(`/projects/${encodeURIComponent(slug)}/docs/${encodeURIComponent(kind)}`, "PUT", {
        markdown: editor.value,
        build_id: buildId || undefined,
      }, context.signal);
      if (!isCurrent(context)) return;
      save.textContent = "Save document";
      save.dataset.label = "Save document";
      setMessage(state, `Saved ${fmtDate(result.updated_at)}.`);
    } catch (error) {
      if (!isAbort(error)) setMessage(state, error.message, true);
    } finally {
      setBusy(save, false);
    }
  });
}

// --- build detail -----------------------------------------------------------

async function listAllArtifacts(slug, buildId, signal) {
  const artifacts = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await api(`/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}/artifacts${query}`, { signal });
    if (!Array.isArray(page.artifacts)) throw new ApiRequestError("Artifact inventory has an invalid shape.", 502);
    artifacts.push(...page.artifacts);
    cursor = page.cursor;
    if (cursor && seenCursors.has(cursor)) throw new ApiRequestError("Artifact inventory returned a repeated cursor.", 502);
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return artifacts;
}

function preflightMarkup(report, buildStatus) {
  const data = report && typeof report === "object" ? report : {};
  const stlReports = data.stl_reports && typeof data.stl_reports === "object" ? Object.entries(data.stl_reports) : [];
  const passedParts = stlReports.filter(([, part]) => part?.ok).length;
  const overall = buildStatus === "verified" || data.ok === true;
  const failed = buildStatus === "failed" || data.ok === false;
  const verdict = overall ? "Passed" : failed ? "Issues found" : "Pending";
  const verdictClass = overall ? "is-pass" : failed ? "is-fail" : "is-unknown";
  const value = (candidate, fallback = "Not reported") => candidate === undefined || candidate === null ? fallback : candidate;
  const booleanCheck = (label, candidate, detail = "") => `
    <li class="check-row ${candidate === true ? "is-pass" : candidate === false ? "is-fail" : "is-unknown"}">
      <span class="check-icon" aria-hidden="true">${candidate === true ? "✓" : candidate === false ? "×" : "·"}</span>
      <span><strong>${esc(label)}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</span>
      <span>${candidate === true ? "pass" : candidate === false ? "flag" : "unknown"}</span>
    </li>`;

  return `
    <section class="k-card preflight" aria-labelledby="preflight-heading">
      <div class="section-heading"><div><h2 id="preflight-heading">Geometry preflight</h2><p>These bounded engine checks are heuristics, not a guarantee of printability, support needs, manufacturing quality, or safety.</p></div></div>
      <div class="summary-grid">
        <div class="summary-card ${verdictClass}"><span>Preflight result</span><strong>${verdict}</strong><small>${buildStatus === "verified" ? "geometry checks passed" : esc(buildStatus)}</small></div>
        <div class="summary-card ${stlReports.length && passedParts === stlReports.length ? "is-pass" : stlReports.length ? "is-fail" : "is-unknown"}"><span>STL checks</span><strong>${passedParts}/${stlReports.length}</strong><small>heuristic checks passed</small></div>
        <div class="summary-card ${data.exit_code === 0 ? "is-pass" : data.exit_code === undefined ? "is-unknown" : "is-fail"}"><span>Script exit</span><strong>${esc(value(data.exit_code))}</strong><small>${data.timed_out ? "timed out" : "exit code"}</small></div>
        <div class="summary-card ${data.timed_out === false ? "is-pass" : data.timed_out ? "is-fail" : "is-unknown"}"><span>Timeout</span><strong>${data.timed_out === true ? "Yes" : data.timed_out === false ? "No" : "Unknown"}</strong><small>runner limit</small></div>
      </div>
      ${stlReports.length ? `<div class="part-grid">${stlReports.map(([path, part]) => {
        const support = part?.support_scan || {};
        return `<article class="part-card">
          <div class="part-card__heading"><h3><code>${esc(path)}</code></h3>${part?.ok ? `<span class="k-tag verified">preflight pass</span>` : `<span class="k-tag failed">issues found</span>`}</div>
          <p class="part-metrics">Extents: <strong>${Array.isArray(part?.extents) ? esc(part.extents.join(" × ")) + " mm" : "not reported"}</strong></p>
          <ul class="check-list">
            ${booleanCheck("Watertight scan", part?.watertight)}
            ${booleanCheck("Printer-fit estimate", part?.bed_fit)}
            ${booleanCheck("Bed-placement check", part?.on_bed)}
            ${booleanCheck("Overhang heuristic", support.within_budget, support.sloped_overhang_mm2 !== undefined ? `${support.sloped_overhang_mm2} mm² estimated area` : "")}
          </ul>
        </article>`;
      }).join("")}</div>` : `<p class="empty">No per-part geometry preflight checks were supplied in this report.</p>`}
      ${Array.isArray(data.notes) && data.notes.length ? `<div class="report-notes"><strong>Engine notes</strong><ul>${data.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul></div>` : ""}
      ${data.error ? `<div class="message message--error"><strong>Build error:</strong> ${esc(data.error)}</div>` : ""}
      <details class="raw-report">
        <summary>Raw engine report</summary>
        <pre>${esc(JSON.stringify(report ?? null, null, 2))}</pre>
      </details>
    </section>`;
}

function pinnedMarkup(build, report) {
  const hasParams = hasOwn(build, "params");
  const manifest = build.source_manifest ?? build.source_versions ?? build.files ?? report?.source_manifest ?? report?.source_versions ?? report?.files;
  if (!hasParams && manifest === undefined) return "";
  return `
    <section class="k-card" aria-labelledby="snapshot-heading">
      <div class="section-heading"><div><h2 id="snapshot-heading">Pinned build snapshot</h2><p>Immutable inputs captured when this build was queued.</p></div></div>
      <div class="snapshot-grid">
        ${hasParams ? `<details open><summary>Pinned parameters</summary><pre>${esc(JSON.stringify(build.params, null, 2))}</pre></details>` : ""}
        ${manifest !== undefined ? `<details open><summary>Source manifest</summary><pre>${esc(JSON.stringify(manifest, null, 2))}</pre></details>` : ""}
      </div>
    </section>`;
}

function stlViewerMarkup(stls, slug, buildId) {
  if (!stls.length) return "";
  const selected = stls.find((artifact) => /^stl\//i.test(artifact.path)) || stls[0];
  return `
    <section class="k-card stl-preview" aria-labelledby="stl-preview-heading">
      <div class="section-heading">
        <div><h2 id="stl-preview-heading">Interactive STL preview</h2><p>Inspect an archived mesh in your browser. This visual preview is separate from geometry preflight.</p></div>
        <span class="access-chip access-chip--public">Public artifact</span>
      </div>
      <label class="field stl-picker">
        <span>Archived STL</span>
        <select id="stl-artifact-select">
          ${stls.map((artifact) => {
            const url = artifactUrl(slug, buildId, artifact.path);
            return `<option value="${esc(url)}" ${artifact.path === selected.path ? "selected" : ""}>${esc(artifact.path)} · ${esc(fmtBytes(artifact.size))}</option>`;
          }).join("")}
        </select>
      </label>
      <stl-viewer src="${esc(artifactUrl(slug, buildId, selected.path))}" model-label="${esc(selected.path)}">
        <a class="k-btn k-btn--ghost stl-viewer-fallback" href="${esc(artifactUrl(slug, buildId, selected.path))}" download>Download ${esc(selected.path)}</a>
      </stl-viewer>
    </section>`;
}

function artifactInventoryMarkup(artifacts, slug, buildId, inventoryError) {
  if (inventoryError) return `<section class="k-card"><h2>Artifact inventory</h2>${errorMarkup(inventoryError)}</section>`;
  return `
    <section class="k-card" aria-labelledby="artifacts-heading">
      <div class="section-heading"><div><h2 id="artifacts-heading">Artifact inventory</h2><p>Authoritative immutable archive listing. Every archived file is downloadable.</p></div><span class="version-chip">${artifacts.length} files</span></div>
      ${artifacts.length ? `<ul class="artifact-list">${artifacts.map((artifact) => {
        const url = artifactUrl(slug, buildId, artifact.path);
        return `<li class="artifact-item">
          <div class="artifact-name"><code>${esc(artifact.path)}</code><span>${esc(fmtBytes(artifact.size))} · uploaded ${esc(fmtDate(artifact.uploaded))}${artifact.etag ? ` · etag <span title="${esc(artifact.etag)}">${esc(String(artifact.etag).slice(0, 12))}</span>` : ""}</span></div>
          <a class="k-btn k-btn--ghost k-btn--sm" href="${esc(url)}" download>Download<span class="sr-only"> ${esc(artifact.path)}</span></a>
        </li>`;
      }).join("")}</ul>` : `<p class="empty">The authoritative archive contains no artifacts.</p>`}
    </section>`;
}

function buildActionsMarkup(status) {
  if (status === "queued" || status === "running") {
    return `<button class="k-btn k-btn--danger" type="button" data-build-action="cancel">Cancel build</button>`;
  }
  return `<button class="k-btn k-btn--ghost" type="button" data-build-action="retry">Retry build</button>`;
}

async function routeBuild(slug, buildId, context, pollAttempt = 0) {
  if (pollAttempt === 0 || !$app.querySelector("#detail")) {
    $app.innerHTML = `
      <div class="crumbs"><a href="#/">projects</a> / <a href="${routeHref(slug)}">${esc(slug)}</a> / ${esc(buildId)}</div>
      <div id="detail" aria-live="polite">Loading build...</div>
    `;
  }
  const detail = $app.querySelector("#detail");
  try {
    const build = await api(`/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}`, { signal: context.signal });
    if (!isCurrent(context)) return;
    const inProgress = build.status === "queued" || build.status === "running";
    const report = build.report_json || {};
    let artifacts = [];
    let inventoryError = null;
    if (!inProgress) {
      try {
        artifacts = await listAllArtifacts(slug, buildId, context.signal);
      } catch (error) {
        if (isAbort(error)) return;
        inventoryError = error;
      }
    }
    if (!isCurrent(context)) return;
    const images = artifacts.filter((artifact) => /\.(png|jpe?g|webp)$/i.test(artifact.path));
    const stls = artifacts.filter((artifact) => /\.stl$/i.test(artifact.path));
    const markdown = artifacts.filter((artifact) => /\.md$/i.test(artifact.path));
    const delay = POLL_DELAYS[Math.min(pollAttempt, POLL_DELAYS.length - 1)];

    detail.innerHTML = `
      <header class="page-header build-header">
        <div>
          <div class="eyebrow">// IMMUTABLE BUILD</div>
          <h1 class="page-title">Build <code>${esc(buildId)}</code> ${badge(build.status)}</h1>
          <div class="slug">source v${esc(build.source_version)} · created ${esc(fmtDate(build.created_at))}${build.finished_at ? ` · finished ${esc(fmtDate(build.finished_at))}` : ""}</div>
        </div>
        <div class="build-actions">${buildActionsMarkup(build.status)}<span class="form-message" id="build-action-state" role="status" aria-live="polite"></span></div>
      </header>
      ${inProgress ? `
        <section class="k-card progress-card" aria-labelledby="progress-heading">
          <div class="progress-orbit" aria-hidden="true"></div>
          <div><h2 id="progress-heading">Build ${esc(build.status)}</h2><p>The engine typically completes in 1-5 minutes. Next status check in ${Math.round(delay / 1000)} seconds; polling pauses while this tab is hidden.</p></div>
        </section>
        ${pinnedMarkup(build, report)}
      ` : `
        ${stlViewerMarkup(stls, slug, buildId)}
        ${images.length ? `<section class="k-card" aria-labelledby="renders-heading"><div class="section-heading"><h2 id="renders-heading">Renders</h2><span class="access-chip access-chip--public">Keyboard accessible</span></div><div class="renders">${images.map((artifact) => renderThumb(artifactUrl(slug, buildId, artifact.path), artifact.path)).join("")}</div></section>` : ""}
        ${preflightMarkup(report, build.status)}
        ${pinnedMarkup(build, report)}
        ${artifactInventoryMarkup(artifacts, slug, buildId, inventoryError)}
        <div id="artifact-docs"></div>
      `}
    `;
    bindBuildActions(slug, buildId, context);
    bindStlViewer();
    if (inProgress) {
      scheduleBuildPoll(slug, buildId, context, pollAttempt, delay);
    } else if (markdown.length) {
      loadArtifactDocs(markdown, slug, buildId, context);
    }
  } catch (error) {
    if (isAbort(error) || !isCurrent(context)) return;
    detail.innerHTML = errorMarkup(error);
  }
}

function bindStlViewer() {
  const select = $app.querySelector("#stl-artifact-select");
  const viewer = $app.querySelector("stl-viewer");
  if (!select || !viewer) return;
  select.addEventListener("change", () => {
    viewer.setAttribute("src", select.value);
    viewer.setAttribute("model-label", select.selectedOptions[0]?.textContent?.split(" · ")[0] || "Archived STL");
    const fallback = viewer.querySelector(".stl-viewer-fallback");
    if (fallback) fallback.href = select.value;
  });
}

function bindBuildActions(slug, buildId, context) {
  const button = $app.querySelector("[data-build-action]");
  if (!button) return;
  const state = $app.querySelector("#build-action-state");
  button.addEventListener("click", async () => {
    const action = button.dataset.buildAction;
    setBusy(button, true, action === "cancel" ? "Cancelling..." : "Retrying...");
    setMessage(state, `${action === "cancel" ? "Cancelling" : "Retrying"} protected build...`);
    try {
      const actionPath = action === "cancel"
        ? `/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}/cancel`
        : `/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}/retry`;
      const result = await writeApi(actionPath, "POST", {}, context.signal);
      if (action === "retry" && result.build_id && result.build_id !== buildId) {
        location.hash = routeHref(slug, `/b/${encodeURIComponent(result.build_id)}`);
      } else {
        route();
      }
    } catch (error) {
      if (!isAbort(error)) setMessage(state, error.message, true);
      setBusy(button, false);
    }
  });
}

async function loadArtifactDocs(markdown, slug, buildId, context) {
  const container = $app.querySelector("#artifact-docs");
  if (!container) return;
  let previewCount = 0;
  const previews = [];
  container.innerHTML = markdown.map((artifact, index) => {
    const size = Number(artifact.size);
    const hasBoundedSize = Number.isFinite(size) && size >= 0 && size <= MAX_MARKDOWN_PREVIEW_BYTES;
    const canPreview = hasBoundedSize && previewCount < MAX_MARKDOWN_PREVIEWS;
    if (canPreview) {
      previewCount += 1;
      previews.push({ artifact, index });
    }
    const previewStatus = canPreview
      ? "Loading Markdown preview..."
      : !hasBoundedSize
        ? `Preview disabled for files larger than ${Math.round(MAX_MARKDOWN_PREVIEW_BYTES / 1024)} KiB.`
        : `Preview limit reached; download this file to inspect it.`;
    return `
    <section class="k-card doc" data-doc-index="${index}">
      <div class="section-heading"><h2>${esc(artifact.path)}</h2><a class="k-btn k-btn--ghost k-btn--sm" href="${esc(artifactUrl(slug, buildId, artifact.path))}" download>Download Markdown</a></div>
      <div class="doc-body"><p class="empty">${esc(previewStatus)}</p></div>
    </section>`;
  }).join("");
  const workers = Array.from(
    { length: Math.min(MARKDOWN_PREVIEW_CONCURRENCY, previews.length) },
    async (_, workerIndex) => {
      for (let index = workerIndex; index < previews.length; index += MARKDOWN_PREVIEW_CONCURRENCY) {
        const preview = previews[index];
        const element = container.querySelector(`[data-doc-index="${preview.index}"] .doc-body`);
        try {
          const text = await request(artifactUrl(slug, buildId, preview.artifact.path).replace(/^\/api/, ""), { responseType: "text", signal: context.signal });
          if (isCurrent(context) && element) element.innerHTML = mdToHtml(text);
        } catch (error) {
          if (!isAbort(error) && isCurrent(context) && element) element.innerHTML = errorMarkup(error);
        }
      }
    }
  );
  await Promise.all(workers);
}

function scheduleBuildPoll(slug, buildId, context, attempt, delay) {
  clearTimeout(pollTimer);
  const run = () => {
    pendingPoll = null;
    pollTimer = null;
    if (isCurrent(context)) routeBuild(slug, buildId, context, attempt + 1);
  };
  pendingPoll = run;
  if (!document.hidden) pollTimer = setTimeout(run, delay);
}

// --- router ----------------------------------------------------------------

function stopRouteWork() {
  routeController?.abort();
  clearTimeout(pollTimer);
  pollTimer = null;
  pendingPoll = null;
}

function routeError(message) {
  $app.innerHTML = `
    <div class="crumbs"><a href="#/">projects</a></div>
    <section class="k-card"><h1 class="page-title">Invalid route</h1><div class="message message--error" role="alert">${esc(message)}</div><a class="k-btn k-btn--ghost" href="#/">Return to projects</a></section>`;
}

function route() {
  stopRouteWork();
  routeController = new AbortController();
  const context = { generation: ++routeGeneration, signal: routeController.signal };
  const hash = location.hash.replace(/^#\/?/, "");
  const rawParts = hash.split("/").filter(Boolean);
  let parts;
  try {
    parts = rawParts.map((part) => decodeURIComponent(part));
  } catch {
    routeError("This URL contains malformed percent-encoding and cannot be decoded safely.");
    return;
  }

  if (!parts.length) {
    routeGallery(context);
  } else if (parts.length === 4 && parts[0] === "p" && parts[2] === "b") {
    routeBuild(parts[1], parts[3], context);
  } else if (parts.length === 4 && parts[0] === "p" && parts[2] === "d") {
    if (!DOC_KINDS.includes(parts[3])) routeError(`Unknown document kind '${parts[3]}'.`);
    else routeDoc(parts[1], parts[3], context);
  } else if (parts.length === 2 && parts[0] === "p") {
    routeProject(parts[1], context);
  } else {
    routeError("No frontend page matches this URL.");
  }
}

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    return;
  }
  refreshServiceStatus();
  if (pendingPoll && !pollTimer) pendingPoll();
});

$status.addEventListener("click", () => {
  if (!location.hash || location.hash === "#/") {
    $app.querySelector("[data-service-status]")?.scrollIntoView({
      behavior: prefersReducedMotion.matches ? "auto" : "smooth",
      block: "start",
    });
  } else {
    location.hash = "#/";
  }
});

setInterval(() => {
  if (!document.hidden) refreshServiceStatus();
}, 30_000);
route();
refreshServiceStatus();
