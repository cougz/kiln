const MAX_FETCH_BYTES = 16 * 1024 * 1024;
const MAX_TRIANGLES = 250_000;
const MAX_CANVAS_DIMENSION = 4096;
const MAX_CANVAS_PIXELS = 4 * 1024 * 1024;
const MAX_DEVICE_PIXEL_RATIO = 2;

const NUMBER_PATTERN = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
let viewerSequence = 0;

class StlViewerError extends Error {
  constructor(message) {
    super(message);
    this.name = "StlViewerError";
  }
}

function vertexPattern() {
  return new RegExp(`\\bvertex\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})(?=\\s|$)`, "gi");
}

function writePosition(data, triangle, vertex, x, y, z, bounds) {
  if (![x, y, z].every(Number.isFinite)) throw new StlViewerError("The STL contains non-finite coordinates.");
  const offset = triangle * 18 + vertex * 6;
  data[offset] = x;
  data[offset + 1] = y;
  data[offset + 2] = z;
  if (![data[offset], data[offset + 1], data[offset + 2]].every(Number.isFinite)) {
    throw new StlViewerError("The STL coordinates exceed WebGL numeric limits.");
  }
  bounds.min[0] = Math.min(bounds.min[0], x);
  bounds.min[1] = Math.min(bounds.min[1], y);
  bounds.min[2] = Math.min(bounds.min[2], z);
  bounds.max[0] = Math.max(bounds.max[0], x);
  bounds.max[1] = Math.max(bounds.max[1], y);
  bounds.max[2] = Math.max(bounds.max[2], z);
}

function finishGeometry(data, triangleCount, bounds, format) {
  if (!triangleCount) throw new StlViewerError("The STL contains no triangles.");
  const dimensions = bounds.max.map((maximum, axis) => maximum - bounds.min[axis]);
  const largest = Math.max(...dimensions);
  if (!Number.isFinite(largest) || largest <= 0) throw new StlViewerError("The STL has no renderable extent.");
  const center = bounds.max.map((maximum, axis) => (maximum + bounds.min[axis]) / 2);
  const scale = 1.6 / largest;

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const start = triangle * 18;
    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = start + vertex * 6;
      data[offset] = (data[offset] - center[0]) * scale;
      data[offset + 1] = (data[offset + 1] - center[1]) * scale;
      data[offset + 2] = (data[offset + 2] - center[2]) * scale;
    }

    const ax = data[start];
    const ay = data[start + 1];
    const az = data[start + 2];
    const ux = data[start + 6] - ax;
    const uy = data[start + 7] - ay;
    const uz = data[start + 8] - az;
    const vx = data[start + 12] - ax;
    const vy = data[start + 13] - ay;
    const vz = data[start + 14] - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-12) {
      nx /= length;
      ny /= length;
      nz /= length;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
    for (let vertex = 0; vertex < 3; vertex++) {
      const normal = start + vertex * 6 + 3;
      data[normal] = nx;
      data[normal + 1] = ny;
      data[normal + 2] = nz;
    }
  }

  return { data, triangleCount, dimensions, format };
}

function parseBinaryStl(bytes, triangleCount) {
  if (triangleCount > MAX_TRIANGLES) {
    throw new StlViewerError(`The STL declares ${triangleCount.toLocaleString()} triangles; the viewer limit is ${MAX_TRIANGLES.toLocaleString()}.`);
  }
  const expected = 84 + triangleCount * 50;
  if (expected > bytes.byteLength) throw new StlViewerError("The binary STL is truncated.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Float32Array(triangleCount * 18);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const record = 84 + triangle * 50;
    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = record + 12 + vertex * 12;
      writePosition(
        data,
        triangle,
        vertex,
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
        bounds,
      );
    }
  }
  return finishGeometry(data, triangleCount, bounds, "binary");
}

function parseAsciiStl(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StlViewerError("The ASCII STL is not valid UTF-8.");
  }

  let vertices = 0;
  for (const match of text.matchAll(vertexPattern())) {
    vertices++;
    if (vertices > MAX_TRIANGLES * 3) {
      throw new StlViewerError(`The STL exceeds the viewer limit of ${MAX_TRIANGLES.toLocaleString()} triangles.`);
    }
    if (!match[1]) break;
  }
  if (!vertices || vertices % 3 !== 0) throw new StlViewerError("The ASCII STL has incomplete triangle facets.");

  const triangleCount = vertices / 3;
  const data = new Float32Array(triangleCount * 18);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let vertex = 0;
  for (const match of text.matchAll(vertexPattern())) {
    writePosition(
      data,
      Math.floor(vertex / 3),
      vertex % 3,
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      bounds,
    );
    vertex++;
  }
  return finishGeometry(data, triangleCount, bounds, "ASCII");
}

function parseStl(bytes) {
  if (!bytes.byteLength) throw new StlViewerError("The STL artifact is empty.");
  const probe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)));
  const looksAscii = /^\s*\uFEFF?solid\b/i.test(probe) || /\bfacet\s+normal\b/i.test(probe);
  if (bytes.byteLength >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triangleCount = view.getUint32(80, true);
    const expected = 84 + triangleCount * 50;
    if (expected === bytes.byteLength || (!looksAscii && expected <= bytes.byteLength)) {
      return parseBinaryStl(bytes, triangleCount);
    }
  }
  if (looksAscii) return parseAsciiStl(bytes);
  throw new StlViewerError("The artifact is not a recognized binary or ASCII STL.");
}

async function readLimitedBody(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_FETCH_BYTES) {
    await response.body?.cancel();
    throw new StlViewerError(`The STL is larger than the ${MAX_FETCH_BYTES / (1024 * 1024)} MB viewer limit.`);
  }
  if (!response.body) throw new StlViewerError("This browser cannot stream the STL safely; download it instead.");

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    if (signal.aborted) {
      await reader.cancel();
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FETCH_BYTES) {
      await reader.cancel();
      throw new StlViewerError(`The STL exceeded the ${MAX_FETCH_BYTES / (1024 * 1024)} MB viewer limit while downloading.`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function matrixMultiply(left, right) {
  const output = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      output[column * 4 + row] =
        left[row] * right[column * 4] +
        left[4 + row] * right[column * 4 + 1] +
        left[8 + row] * right[column * 4 + 2] +
        left[12 + row] * right[column * 4 + 3];
    }
  }
  return output;
}

function perspectiveMatrix(aspect) {
  const near = 0.1;
  const far = 100;
  const focal = 1 / Math.tan(Math.PI / 8);
  const matrix = new Float32Array(16);
  matrix[0] = focal / Math.max(aspect, 0.01);
  matrix[5] = focal;
  matrix[10] = (far + near) / (near - far);
  matrix[11] = -1;
  matrix[14] = (2 * far * near) / (near - far);
  return matrix;
}

function translationMatrix(z) {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  matrix[14] = z;
  return matrix;
}

function rotationMatrix(yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y = new Float32Array([
    cy, 0, -sy, 0,
    0, 1, 0, 0,
    sy, 0, cy, 0,
    0, 0, 0, 1,
  ]);
  const x = new Float32Array([
    1, 0, 0, 0,
    0, cp, sp, 0,
    0, -sp, cp, 0,
    0, 0, 0, 1,
  ]);
  return matrixMultiply(x, y);
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new StlViewerError("WebGL could not create a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new StlViewerError("WebGL could not compile the viewer shaders.");
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 a_position;
    attribute vec3 a_normal;
    uniform mat4 u_matrix;
    uniform mat4 u_rotation;
    varying vec3 v_normal;
    void main() {
      gl_Position = u_matrix * vec4(a_position, 1.0);
      v_normal = mat3(u_rotation) * a_normal;
    }
  `);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec3 v_normal;
    uniform vec3 u_color;
    void main() {
      vec3 light = normalize(vec3(0.45, 0.8, 0.65));
      float diffuse = abs(dot(normalize(v_normal), light));
      gl_FragColor = vec4(u_color * (0.28 + 0.72 * diffuse), 1.0);
    }
  `);
  const program = gl.createProgram();
  if (!program) throw new StlViewerError("WebGL could not create a render program.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    throw new StlViewerError("WebGL could not link the viewer shaders.");
  }
  return program;
}

function shortDimension(value) {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

class StlViewer extends HTMLElement {
  static get observedAttributes() {
    return ["src", "model-label"];
  }

  connectedCallback() {
    this._connected = true;
    this._buildInterface();
    this._resizeObserver = new ResizeObserver(() => this._scheduleRender());
    this._resizeObserver.observe(this._canvas);
    this._darkMode = matchMedia("(prefers-color-scheme: dark)");
    this._colorChange = () => this._scheduleRender();
    this._darkMode.addEventListener("change", this._colorChange);
    this._load();
  }

  disconnectedCallback() {
    this._connected = false;
    this._request?.abort();
    this._resizeObserver?.disconnect();
    this._darkMode?.removeEventListener("change", this._colorChange);
    this._destroyWebGl();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (!this._connected || oldValue === newValue) return;
    if (name === "src") this._load();
    if (name === "model-label") this._syncLabels();
  }

  _buildInterface() {
    const id = `stl-viewer-${++viewerSequence}`;
    this.dataset.state = "loading";
    this.innerHTML = `
      <div class="stl-viewer">
        <div class="stl-viewer__toolbar">
          <div class="stl-viewer__controls" role="group" aria-label="STL camera views">
            <button class="k-btn k-btn--ghost k-btn--sm" type="button" data-view="reset" disabled>Reset</button>
            <button class="k-btn k-btn--ghost k-btn--sm" type="button" data-view="front" disabled>Front</button>
            <button class="k-btn k-btn--ghost k-btn--sm" type="button" data-view="top" disabled>Top</button>
            <button class="k-btn k-btn--ghost k-btn--sm" type="button" data-view="side" disabled>Side</button>
          </div>
          <a class="k-btn k-btn--ghost k-btn--sm stl-viewer__download" download>Download STL</a>
        </div>
        <canvas class="stl-viewer__canvas" tabindex="0" role="img"></canvas>
        <div class="stl-viewer__foot">
          <p class="stl-viewer__status" id="${id}-status" role="status" aria-live="polite">Loading STL...</p>
          <p class="stl-viewer__help" id="${id}-help">Drag to orbit; use the wheel to zoom. Arrow keys orbit, plus/minus zoom, and Home resets. No automatic motion.</p>
        </div>
      </div>`;
    this._canvas = this.querySelector("canvas");
    this._status = this.querySelector(".stl-viewer__status");
    this._download = this.querySelector(".stl-viewer__download");
    this._buttons = [...this.querySelectorAll("[data-view]")];
    this._canvas.setAttribute("aria-describedby", `${id}-status ${id}-help`);
    this._syncLabels();
    this._buttons.forEach((button) => button.addEventListener("click", () => this._setView(button.dataset.view)));
    this._canvas.addEventListener("pointerdown", (event) => this._pointerDown(event));
    this._canvas.addEventListener("pointermove", (event) => this._pointerMove(event));
    this._canvas.addEventListener("pointerup", (event) => this._pointerEnd(event));
    this._canvas.addEventListener("pointercancel", (event) => this._pointerEnd(event));
    this._canvas.addEventListener("wheel", (event) => this._wheel(event), { passive: false });
    this._canvas.addEventListener("keydown", (event) => this._keyDown(event));
    this._canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this._contextLost = true;
      this.dataset.state = "error";
      this._status.textContent = "The WebGL context was lost. Waiting for the browser to restore it; download remains available.";
    });
    this._canvas.addEventListener("webglcontextrestored", () => {
      this._contextLost = false;
      try {
        this._initializeWebGl();
        if (this._geometry) {
          this._uploadGeometry();
          this._setReady();
        } else {
          this._load();
        }
      } catch (error) {
        this._showError(error);
      }
    });
    this._setView("reset");
  }

  _syncLabels() {
    if (!this._canvas) return;
    const label = this.getAttribute("model-label") || "archived STL";
    this._canvas.setAttribute("aria-label", `Interactive 3D preview of ${label}`);
    this._download.setAttribute("aria-label", `Download ${label}`);
    this._download.download = label.toLowerCase().endsWith(".stl") ? label.split("/").pop() : "model.stl";
  }

  _artifactUrl() {
    const raw = this.getAttribute("src");
    if (!raw) throw new StlViewerError("No STL artifact was selected.");
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) {
      throw new StlViewerError("The viewer only loads same-origin STL artifacts.");
    }
    return url;
  }

  async _load() {
    this._request?.abort();
    this._clearGeometry();
    let url;
    try {
      url = this._artifactUrl();
    } catch (error) {
      this._download.removeAttribute("href");
      this._showError(error);
      return;
    }
    this._download.href = url.href;
    this._syncLabels();
    if (!this._gl && !this._contextLost) {
      try {
        if (!this._initializeWebGl()) throw new StlViewerError("WebGL is unavailable in this browser.");
      } catch (error) {
        this._destroyWebGl();
        this._showError(error);
        return;
      }
    }

    const request = new AbortController();
    this._request = request;
    this.dataset.state = "loading";
    this.setAttribute("aria-busy", "true");
    this._status.setAttribute("role", "status");
    this._status.textContent = `Loading ${this.getAttribute("model-label") || "STL"}...`;
    this._buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch(url, {
        signal: request.signal,
        credentials: "same-origin",
        headers: { Accept: "model/stl, application/octet-stream;q=0.9, text/plain;q=0.8" },
      });
      if (!response.ok) throw new StlViewerError(`The STL request failed with HTTP ${response.status}.`);
      const bytes = await readLimitedBody(response, request.signal);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (request.signal.aborted || this._request !== request) return;
      this._geometry = parseStl(bytes);
      this._uploadGeometry();
      this._setView("reset");
      this._setReady();
    } catch (error) {
      if (error?.name !== "AbortError" && this._request === request) this._showError(error);
    }
  }

  _initializeWebGl() {
    const gl = this._canvas.getContext("webgl", {
      alpha: false,
      antialias: true,
      depth: true,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    if (!gl) return false;
    this._gl = gl;
    this._program = createProgram(gl);
    this._locations = {
      position: gl.getAttribLocation(this._program, "a_position"),
      normal: gl.getAttribLocation(this._program, "a_normal"),
      matrix: gl.getUniformLocation(this._program, "u_matrix"),
      rotation: gl.getUniformLocation(this._program, "u_rotation"),
      color: gl.getUniformLocation(this._program, "u_color"),
    };
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    return true;
  }

  _uploadGeometry() {
    const gl = this._gl;
    if (!gl || !this._geometry) return;
    if (this._buffer) gl.deleteBuffer(this._buffer);
    this._buffer = gl.createBuffer();
    if (!this._buffer) throw new StlViewerError("WebGL could not allocate a geometry buffer.");
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this._geometry.data, gl.STATIC_DRAW);
    if (gl.getError() !== gl.NO_ERROR) throw new StlViewerError("The browser could not upload this mesh to the GPU.");
  }

  _setReady() {
    if (!this._geometry) return;
    this.dataset.state = "ready";
    this.removeAttribute("aria-busy");
    this._status.setAttribute("role", "status");
    this._buttons.forEach((button) => { button.disabled = false; });
    const dimensions = this._geometry.dimensions.map(shortDimension).join(" × ");
    const label = this.getAttribute("model-label") || "STL";
    this._status.textContent = `${label}: ${this._geometry.triangleCount.toLocaleString()} triangles, ${dimensions} model units, ${this._geometry.format}.`;
    this._scheduleRender();
  }

  _showError(error) {
    this.dataset.state = "error";
    this.removeAttribute("aria-busy");
    this._status?.setAttribute("role", "alert");
    this._buttons?.forEach((button) => { button.disabled = true; });
    this._status.textContent = `Preview unavailable: ${error?.message || "unknown viewer error"} Download the STL to inspect it locally.`;
    this._scheduleRender();
  }

  _clearGeometry() {
    if (this._gl && this._buffer) this._gl.deleteBuffer(this._buffer);
    this._buffer = null;
    this._geometry = null;
    this._scheduleRender();
  }

  _destroyWebGl() {
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = null;
    if (this._gl && this._buffer) this._gl.deleteBuffer(this._buffer);
    if (this._gl && this._program) this._gl.deleteProgram(this._program);
    this._buffer = null;
    this._program = null;
    this._gl = null;
  }

  _setView(view) {
    if (view === "front") {
      this._yaw = 0;
      this._pitch = 0;
      this._distance = 3.8;
    } else if (view === "top") {
      this._yaw = 0;
      this._pitch = -1.5;
      this._distance = 3.8;
    } else if (view === "side") {
      this._yaw = Math.PI / 2;
      this._pitch = 0;
      this._distance = 3.8;
    } else {
      this._yaw = -0.7;
      this._pitch = -0.45;
      this._distance = 3.8;
    }
    this._scheduleRender();
  }

  _pointerDown(event) {
    if (!this._geometry || event.button !== 0 || !event.isPrimary) return;
    this._pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this._canvas.setPointerCapture(event.pointerId);
    this._canvas.classList.add("is-dragging");
    this._canvas.focus({ preventScroll: true });
  }

  _pointerMove(event) {
    if (!this._pointer || event.pointerId !== this._pointer.id) return;
    const dx = event.clientX - this._pointer.x;
    const dy = event.clientY - this._pointer.y;
    this._pointer.x = event.clientX;
    this._pointer.y = event.clientY;
    this._yaw += dx * 0.01;
    this._pitch = Math.max(-1.5, Math.min(1.5, this._pitch + dy * 0.01));
    this._scheduleRender();
  }

  _pointerEnd(event) {
    if (!this._pointer || event.pointerId !== this._pointer.id) return;
    this._pointer = null;
    this._canvas.classList.remove("is-dragging");
    if (this._canvas.hasPointerCapture(event.pointerId)) this._canvas.releasePointerCapture(event.pointerId);
  }

  _wheel(event) {
    if (!this._geometry) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1;
    this._distance = Math.max(2.1, Math.min(9, this._distance * Math.exp(event.deltaY * unit * 0.001)));
    this._scheduleRender();
  }

  _keyDown(event) {
    if (!this._geometry) return;
    const step = event.shiftKey ? 0.2 : 0.08;
    let handled = true;
    if (event.key === "ArrowLeft") this._yaw -= step;
    else if (event.key === "ArrowRight") this._yaw += step;
    else if (event.key === "ArrowUp") this._pitch = Math.max(-1.5, this._pitch - step);
    else if (event.key === "ArrowDown") this._pitch = Math.min(1.5, this._pitch + step);
    else if (event.key === "+" || event.key === "=") this._distance = Math.max(2.1, this._distance * 0.9);
    else if (event.key === "-" || event.key === "_") this._distance = Math.min(9, this._distance * 1.1);
    else if (event.key === "Home" || event.key === "0") this._setView("reset");
    else handled = false;
    if (handled) {
      event.preventDefault();
      this._scheduleRender();
    }
  }

  _scheduleRender() {
    if (!this._connected || this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this._render();
    });
  }

  _render() {
    const gl = this._gl;
    if (!gl || this._contextLost) return;
    const bounds = this._canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    let width = Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.round(bounds.width * ratio)));
    let height = Math.max(1, Math.min(MAX_CANVAS_DIMENSION, Math.round(bounds.height * ratio)));
    if (width * height > MAX_CANVAS_PIXELS) {
      const scale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
      width = Math.max(1, Math.floor(width * scale));
      height = Math.max(1, Math.floor(height * scale));
    }
    if (this._canvas.width !== width || this._canvas.height !== height) {
      this._canvas.width = width;
      this._canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    const dark = this._darkMode?.matches;
    gl.clearColor(dark ? 0.045 : 0.075, dark ? 0.045 : 0.075, dark ? 0.045 : 0.075, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this._geometry || !this._buffer || !this._program) return;

    const rotation = rotationMatrix(this._yaw, this._pitch);
    const view = matrixMultiply(translationMatrix(-this._distance), rotation);
    const matrix = matrixMultiply(perspectiveMatrix(width / height), view);
    gl.useProgram(this._program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.enableVertexAttribArray(this._locations.position);
    gl.vertexAttribPointer(this._locations.position, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(this._locations.normal);
    gl.vertexAttribPointer(this._locations.normal, 3, gl.FLOAT, false, 24, 12);
    gl.uniformMatrix4fv(this._locations.matrix, false, matrix);
    gl.uniformMatrix4fv(this._locations.rotation, false, rotation);
    gl.uniform3f(this._locations.color, dark ? 1 : 0.96, dark ? 0.4 : 0.29, dark ? 0.14 : 0.06);
    gl.drawArrays(gl.TRIANGLES, 0, this._geometry.triangleCount * 3);
  }
}

if (!customElements.get("stl-viewer")) customElements.define("stl-viewer", StlViewer);
