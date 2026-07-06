// kiln frontend — no build step, vanilla JS hash router over the REST API
// (src/api.ts). Kept intentionally small: a project gallery, a project
// detail view, and a build page with report + renders + artifact links.

const $app = document.getElementById("app");
const $status = document.getElementById("status");

const api = (path) => fetch(`/api${path}`).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  return body;
});

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

const fmtDate = (s) => (s ? s.replace("T", " ").replace(/\.\d+Z?$/, "") : "");

const badge = (status) =>
  `<span class="badge ${esc(status)}">${esc(status)}</span>`;

function artifactUrl(slug, buildId, path) {
  return `/api/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}/artifacts/${path}`;
}

// --- routes --------------------------------------------------------------

async function routeGallery() {
  $app.innerHTML = `
    <form class="create-project" id="create-form">
      <input name="slug" placeholder="slug (lowercase-dashes)" required pattern="[a-z0-9][a-z0-9-]{1,63}">
      <input name="name" placeholder="name (optional)">
      <button type="submit">New project</button>
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
    $list.innerHTML = projects.map((p) => `
      <a class="card card-link" href="#/p/${encodeURIComponent(p.slug)}">
        <h2>${esc(p.name)}</h2>
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

    const builds = p.recent_builds.length ? `
      <table>
        <tr><th>build</th><th>status</th><th>created</th></tr>
        ${p.recent_builds.map((b) => `
          <tr class="row-link" onclick="location.hash='#/p/${encodeURIComponent(slug)}/b/${encodeURIComponent(b.id)}'">
            <td><code>${esc(b.id)}</code></td>
            <td>${badge(b.status)}</td>
            <td>${esc(fmtDate(b.created_at))}</td>
          </tr>
        `).join("")}
      </table>
    ` : `<p class="empty">no builds yet</p>`;

    $d.innerHTML = `
      <div class="card">
        <h2>${esc(p.name)}</h2>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
      </div>
      <div class="card">
        <h3>Sources</h3>
        <ul class="artifact-list">${sources}</ul>
      </div>
      <div class="card">
        <h3>Builds</h3>
        ${builds}
      </div>
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
    const report = b.report_json || {};
    const artifacts = report.artifacts || [];
    const images = artifacts.filter((a) => a.endsWith(".png"));
    const stls = artifacts.filter((a) => a.endsWith(".stl"));
    const docs = artifacts.filter((a) => a.endsWith(".md"));
    const other = artifacts.filter((a) => !images.includes(a) && !stls.includes(a) && !docs.includes(a));

    $d.innerHTML = `
      <div class="card">
        <h2>Build ${esc(buildId)} ${badge(b.status)}</h2>
        <div class="slug">source v${b.source_version} · created ${esc(fmtDate(b.created_at))}${b.finished_at ? " · finished " + esc(fmtDate(b.finished_at)) : ""}</div>
      </div>
      ${images.length ? `
        <div class="card">
          <h3>Renders</h3>
          <div class="renders">
            ${images.map((p) => `<img src="${artifactUrl(slug, buildId, p)}" alt="${esc(p)}" loading="lazy">`).join("")}
          </div>
        </div>
      ` : ""}
      <div class="card">
        <h3>Artifacts</h3>
        ${artifacts.length ? `<ul class="artifact-list">${
          [...stls, ...other, ...images].map((p) => `
            <li><code>${esc(p)}</code> <a class="btn" href="${artifactUrl(slug, buildId, p)}" download>download</a></li>
          `).join("")
        }</ul>` : `<p class="empty">no artifacts</p>`}
      </div>
      ${docs.map((p) => `<div class="card doc" data-path="${esc(p)}"><h3>${esc(p)}</h3><pre>loading…</pre></div>`).join("")}
      <div class="card">
        <h3>Verification report</h3>
        <pre>${esc(JSON.stringify(report, null, 2))}</pre>
      </div>
    `;

    for (const el of $d.querySelectorAll(".doc")) {
      const path = el.dataset.path;
      fetch(artifactUrl(slug, buildId, path))
        .then((r) => r.text())
        .then((text) => { el.querySelector("pre").textContent = text; })
        .catch((err) => { el.querySelector("pre").textContent = `error: ${err.message}`; });
    }
  } catch (err) {
    $d.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// --- router ---------------------------------------------------------------

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1] && parts[2] === "b" && parts[3]) {
    routeBuild(decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
  } else if (parts[0] === "p" && parts[1]) {
    routeProject(decodeURIComponent(parts[1]));
  } else {
    routeGallery();
  }
}

window.addEventListener("hashchange", route);
route();

fetch("/api/health").then((r) => r.json()).then((h) => {
  $status.textContent = `phase ${h.phase} · d1 ${h.d1 ? "ok" : "down"} · r2 ${h.r2 ? "ok" : "down"} · mcp ${h.mcp ? "open" : "off"}`;
}).catch(() => { $status.textContent = "api unreachable"; });
