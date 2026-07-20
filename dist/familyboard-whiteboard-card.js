/**
 * Familyboard Whiteboard Card
 *
 * A freehand drawing board (pen + eraser) with draggable, typeable text
 * notes on top, backed by the "Familyboard Whiteboard" custom
 * integration's WebSocket API (get_board/save_board).
 *
 * Unlike the other Familyboard cards, this one builds its DOM chrome
 * (toolbar + canvas + notes layer) exactly once and never replaces it via
 * innerHTML afterwards - a full re-render while the user has a pointer
 * down mid-stroke, or is mid-sentence in a note, would tear the drawing
 * apart or blow away unsaved keystrokes. Data updates instead redraw the
 * canvas from stored stroke data and rebuild only the notes layer, both
 * skipped while the user is actively interacting (_isBusy()).
 */

// "auto" resolves to the current theme's primary text color at the moment a
// stroke is drawn (dark ink on a light board, light ink on a dark board),
// so the default pen stays visible whichever mode the wallboard is in.
// Once drawn, a stroke's color is baked in and won't change if the theme
// flips later - same as real ink.
const PEN_COLORS = ["auto", "#F2A6A0", "#8FC1D4", "#A8D5BA", "#C9A6E0", "#F2A65A"];
const NOTE_COLORS = ["#F6D186", "#A8D5BA", "#C9A6E0", "#8FC1D4", "#F2A6A0", "#E397C4"];
const PEN_WIDTHS = [3, 6, 12];
const ERASER_WIDTH = 26;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function randomId() {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

class FamilyboardWhiteboardCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._built = false;
    this._initialized = false;
    this._lastSignature = null;
    this._board = { strokes: [], notes: [] };
    this._tool = "pen";
    this._color = PEN_COLORS[0];
    this._width = PEN_WIDTHS[1];
    this._drawing = null;
    this._lastPoint = null;
    this._draggingNoteId = null;
    this._editingNoteId = null;
    this._saveTimer = null;
    this._pollTimer = null;
    this._resizeObserver = null;
    this._cssWidth = 0;
    this._cssHeight = 0;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("familyboard-whiteboard-card: 'entity' is required (the Familyboard Whiteboard sensor entity).");
    }
    this._config = { title: null, height: 480, language: "de", ...config };
    if (!this._built) this._buildChrome();
    this._headerTitleEl.textContent = this._config.title || "Whiteboard";
    this._wrapEl.style.height = `${Number(this._config.height) || 480}px`;
  }

  set hass(hass) {
    const prevEntityState = this._hass ? this._hass.states[this._config?.entity] : null;
    this._hass = hass;
    if (!this._config) return;
    if (!this._built) this._buildChrome();

    const entityState = hass.states[this._config.entity];
    if (!entityState) {
      this._setWarning(`Entity "${escapeHtml(this._config.entity)}" not found.`);
      return;
    }
    this._clearWarning();

    const signature = `${entityState.attributes.stroke_count}|${entityState.attributes.note_count}|${entityState.state}`;
    if ((signature !== this._lastSignature || !prevEntityState) && !this._isBusy()) {
      this._lastSignature = signature;
      this._fetchBoard(entityState);
    }
  }

  connectedCallback() {
    this._pollTimer = window.setInterval(() => {
      if (this._isBusy() || !this._hass || !this._config) return;
      const entityState = this._hass.states[this._config.entity];
      if (entityState) this._fetchBoard(entityState);
    }, 60 * 1000);
  }

  disconnectedCallback() {
    if (this._pollTimer) window.clearInterval(this._pollTimer);
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }

  _isBusy() {
    return Boolean(this._drawing) || Boolean(this._draggingNoteId) || Boolean(this._editingNoteId);
  }

  getCardSize() {
    return Math.ceil((Number(this._config?.height) || 480) / 50) + 2;
  }

  static getStubConfig(hass) {
    const match = Object.keys(hass.states).find(
      (id) =>
        id.startsWith("sensor.") &&
        "config_entry_id" in hass.states[id].attributes &&
        "stroke_count" in hass.states[id].attributes
    );
    return { entity: match || "sensor.whiteboard_whiteboard" };
  }

  static getConfigElement() {
    return document.createElement("familyboard-whiteboard-card-editor");
  }

  // -- Networking ---------------------------------------------------------

  async _fetchBoard(entityState) {
    const configEntryId = entityState.attributes.config_entry_id;
    if (!configEntryId) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "familyboard_whiteboard/get_board",
        config_entry_id: configEntryId,
      });
      this._board = { strokes: result.strokes || [], notes: result.notes || [] };
      this._initialized = true;
      this._renderBoardContent();
      this._renderNotes();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("familyboard-whiteboard-card: failed to fetch board", err);
    }
  }

  async _saveBoard() {
    if (!this._hass || !this._config) return;
    const entityState = this._hass.states[this._config.entity];
    const configEntryId = entityState && entityState.attributes.config_entry_id;
    if (!configEntryId) return;
    try {
      await this._hass.connection.sendMessagePromise({
        type: "familyboard_whiteboard/save_board",
        config_entry_id: configEntryId,
        strokes: this._board.strokes,
        notes: this._board.notes,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("familyboard-whiteboard-card: failed to save board", err);
    }
  }

  _scheduleSave(immediate) {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    if (immediate) {
      this._saveBoard();
      return;
    }
    this._saveTimer = window.setTimeout(() => this._saveBoard(), 800);
  }

  // -- One-time DOM construction ------------------------------------------

  _buildChrome() {
    this._built = true;
    this.shadowRoot.innerHTML = `${this._styleTag()}
      <div class="fb-card">
        <div class="header">
          <div class="header-title"></div>
          <div class="toolbar">
            <div class="tool-group">
              <button type="button" class="tool-btn" data-tool="pen" title="Stift">✏️</button>
              <button type="button" class="tool-btn" data-tool="eraser" title="Radierer">🧽</button>
            </div>
            <div class="tool-group colors"></div>
            <div class="tool-group widths"></div>
            <div class="tool-group">
              <button type="button" class="tool-btn text-btn" title="Text hinzufügen">🔤 Text</button>
              <button type="button" class="tool-btn clear-btn" title="Alles löschen">🗑</button>
            </div>
          </div>
        </div>
        <div class="warning" hidden></div>
        <div class="board-wrap">
          <canvas class="board-canvas"></canvas>
          <div class="notes-layer"></div>
        </div>
      </div>`;

    this._headerTitleEl = this.shadowRoot.querySelector(".header-title");
    this._warningEl = this.shadowRoot.querySelector(".warning");
    this._wrapEl = this.shadowRoot.querySelector(".board-wrap");
    this._canvasEl = this.shadowRoot.querySelector(".board-canvas");
    this._notesLayerEl = this.shadowRoot.querySelector(".notes-layer");

    this._buildColorSwatches();
    this._buildWidthButtons();
    this._buildToolButtons();

    this.shadowRoot.querySelector(".text-btn").addEventListener("click", () => this._addNote());
    this.shadowRoot.querySelector(".clear-btn").addEventListener("click", () => this._clearBoard());

    this._canvasEl.addEventListener("pointerdown", (ev) => this._onPointerDown(ev));
    this._canvasEl.addEventListener("pointermove", (ev) => this._onPointerMove(ev));
    this._canvasEl.addEventListener("pointerup", (ev) => this._onPointerUp(ev));
    this._canvasEl.addEventListener("pointercancel", (ev) => this._onPointerUp(ev));

    this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
    this._resizeObserver.observe(this._wrapEl);
  }

  _buildToolButtons() {
    const buttons = this.shadowRoot.querySelectorAll(".tool-btn[data-tool]");
    const syncActive = () => {
      buttons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tool === this._tool));
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        this._tool = btn.dataset.tool;
        syncActive();
      });
    });
    syncActive();
  }

  _resolveColor(color) {
    if (color !== "auto") return color;
    const resolved = getComputedStyle(this).getPropertyValue("--primary-text-color").trim();
    return resolved || "#2b2320";
  }

  _buildColorSwatches() {
    const container = this.shadowRoot.querySelector(".colors");
    container.innerHTML = PEN_COLORS.map(
      (c) =>
        `<button type="button" class="swatch" data-color="${c}" style="background:${
          c === "auto" ? "var(--primary-text-color, #2b2320)" : c
        }"></button>`
    ).join("");
    const swatches = container.querySelectorAll(".swatch");
    const syncActive = () => {
      swatches.forEach((s) => s.classList.toggle("active", s.dataset.color === this._color));
    };
    swatches.forEach((s) => {
      s.addEventListener("click", () => {
        this._color = s.dataset.color;
        syncActive();
      });
    });
    syncActive();
  }

  _buildWidthButtons() {
    const container = this.shadowRoot.querySelector(".widths");
    container.innerHTML = PEN_WIDTHS.map(
      (w) => `<button type="button" class="width-btn" data-width="${w}"><span style="width:${w}px;height:${w}px;"></span></button>`
    ).join("");
    const buttons = container.querySelectorAll(".width-btn");
    const syncActive = () => {
      buttons.forEach((b) => b.classList.toggle("active", Number(b.dataset.width) === this._width));
    };
    buttons.forEach((b) => {
      b.addEventListener("click", () => {
        this._width = Number(b.dataset.width);
        syncActive();
      });
    });
    syncActive();
  }

  _setWarning(text) {
    this._warningEl.textContent = text;
    this._warningEl.removeAttribute("hidden");
  }

  _clearWarning() {
    this._warningEl.setAttribute("hidden", "");
  }

  // -- Canvas ---------------------------------------------------------------

  _resizeCanvas() {
    if (!this._canvasEl.isConnected) return;
    const cssWidth = this._wrapEl.clientWidth;
    const cssHeight = this._wrapEl.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    this._canvasEl.width = Math.round(cssWidth * dpr);
    this._canvasEl.height = Math.round(cssHeight * dpr);
    this._canvasEl.style.width = `${cssWidth}px`;
    this._canvasEl.style.height = `${cssHeight}px`;
    this._canvasEl.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssWidth = cssWidth;
    this._cssHeight = cssHeight;
    this._renderBoardContent();
    this._renderNotes();
  }

  _renderBoardContent() {
    if (!this._cssWidth || !this._cssHeight) return;
    const ctx = this._canvasEl.getContext("2d");
    ctx.clearRect(0, 0, this._cssWidth, this._cssHeight);
    for (const stroke of this._board.strokes) this._drawStrokePath(ctx, stroke);
  }

  _drawStrokePath(ctx, stroke) {
    const points = stroke.points || [];
    ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
    if (points.length < 2) {
      if (points.length === 1) {
        const [nx, ny] = points[0];
        ctx.fillStyle = stroke.color;
        ctx.beginPath();
        ctx.arc(nx * this._cssWidth, ny * this._cssHeight, stroke.width / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      return;
    }
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const [x0, y0] = points[0];
    ctx.moveTo(x0 * this._cssWidth, y0 * this._cssHeight);
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i];
      ctx.lineTo(x * this._cssWidth, y * this._cssHeight);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }

  _canvasPoint(ev) {
    const rect = this._canvasEl.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  _onPointerDown(ev) {
    if (this._tool !== "pen" && this._tool !== "eraser") return;
    ev.preventDefault();
    const [x, y] = this._canvasPoint(ev);
    this._drawing = {
      color: this._tool === "eraser" ? "#000000" : this._resolveColor(this._color),
      width: this._tool === "eraser" ? ERASER_WIDTH : this._width,
      tool: this._tool,
      points: [[x / this._cssWidth, y / this._cssHeight]],
    };
    this._lastPoint = [x, y];
    this._canvasEl.setPointerCapture(ev.pointerId);
  }

  _onPointerMove(ev) {
    if (!this._drawing) return;
    const [x, y] = this._canvasPoint(ev);
    const ctx = this._canvasEl.getContext("2d");
    ctx.globalCompositeOperation = this._drawing.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = this._drawing.color;
    ctx.lineWidth = this._drawing.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(this._lastPoint[0], this._lastPoint[1]);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    this._lastPoint = [x, y];
    this._drawing.points.push([x / this._cssWidth, y / this._cssHeight]);
  }

  _onPointerUp() {
    if (!this._drawing) return;
    this._board.strokes.push(this._drawing);
    this._drawing = null;
    this._lastPoint = null;
    this._scheduleSave(true);
  }

  // -- Text notes -----------------------------------------------------------

  _addNote() {
    const note = {
      id: randomId(),
      text: "",
      x: 0.38 + Math.random() * 0.2,
      y: 0.32 + Math.random() * 0.2,
      color: NOTE_COLORS[this._board.notes.length % NOTE_COLORS.length],
    };
    this._board.notes.push(note);
    this._renderNotes();
    this._scheduleSave(true);
    requestAnimationFrame(() => {
      const el = this._notesLayerEl.querySelector(`[data-note-id="${note.id}"] .note-text`);
      if (el) el.focus();
    });
  }

  _renderNotes() {
    if (this._draggingNoteId) return;
    this._notesLayerEl.innerHTML = this._board.notes
      .map(
        (note) => `
      <div class="note" data-note-id="${escapeHtml(note.id)}" style="
          left:${note.x * this._cssWidth}px; top:${note.y * this._cssHeight}px; background:${note.color};
        ">
        <div class="note-head">
          <span class="note-handle" title="Verschieben">⠿</span>
          <button type="button" class="note-delete" title="Löschen">✕</button>
        </div>
        <div class="note-text" contenteditable="true" data-placeholder="Notiz...">${escapeHtml(note.text)}</div>
      </div>`
      )
      .join("");

    this._notesLayerEl.querySelectorAll(".note").forEach((noteEl) => {
      const noteId = noteEl.dataset.noteId;
      const note = this._board.notes.find((n) => n.id === noteId);
      if (!note) return;

      const textEl = noteEl.querySelector(".note-text");
      // The note lives inside this card's shadow root, so HA's global
      // keyboard-shortcut handler (bound on `document`, e.g. "e" for the
      // entity quick-bar, "c" for commands, ...) doesn't reliably detect
      // that a contenteditable field has focus and fires anyway. Stop the
      // keydown/keypress/keyup from bubbling past the note so HA never
      // sees it while typing here; the browser's own text editing still
      // works since that isn't driven by propagation.
      const stopKeyBubble = (ev) => ev.stopPropagation();
      textEl.addEventListener("keydown", stopKeyBubble);
      textEl.addEventListener("keyup", stopKeyBubble);
      textEl.addEventListener("keypress", stopKeyBubble);
      textEl.addEventListener("focus", () => {
        this._editingNoteId = noteId;
      });
      textEl.addEventListener("input", () => {
        note.text = textEl.textContent;
        this._scheduleSave(false);
      });
      textEl.addEventListener("blur", () => {
        this._editingNoteId = null;
        note.text = textEl.textContent;
        this._scheduleSave(true);
      });

      noteEl.querySelector(".note-delete").addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._board.notes = this._board.notes.filter((n) => n.id !== noteId);
        this._renderNotes();
        this._scheduleSave(true);
      });

      const handle = noteEl.querySelector(".note-handle");
      handle.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._draggingNoteId = noteId;
        const wrapRect = this._wrapEl.getBoundingClientRect();
        const noteRect = noteEl.getBoundingClientRect();
        const offsetX = ev.clientX - noteRect.left;
        const offsetY = ev.clientY - noteRect.top;
        handle.setPointerCapture(ev.pointerId);

        const onMove = (mv) => {
          const x = mv.clientX - wrapRect.left - offsetX;
          const y = mv.clientY - wrapRect.top - offsetY;
          noteEl.style.left = `${x}px`;
          noteEl.style.top = `${y}px`;
        };
        const onUp = (up) => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          const x = up.clientX - wrapRect.left - offsetX;
          const y = up.clientY - wrapRect.top - offsetY;
          note.x = Math.min(1, Math.max(0, x / this._cssWidth));
          note.y = Math.min(1, Math.max(0, y / this._cssHeight));
          this._draggingNoteId = null;
          this._scheduleSave(true);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
      });
    });
  }

  _clearBoard() {
    const msg =
      this._config.language === "en"
        ? "Clear the entire whiteboard? This can't be undone."
        : "Whiteboard wirklich komplett leeren? Das kann nicht rückgängig gemacht werden.";
    // eslint-disable-next-line no-alert
    if (!window.confirm(msg)) return;
    this._board = { strokes: [], notes: [] };
    this._renderBoardContent();
    this._renderNotes();
    this._scheduleSave(true);
  }

  _styleTag() {
    return `<style>
      :host { display: block; }
      .fb-card {
        font-family: var(--paper-font-body1_-_font-family, "Nunito", "Segoe UI", sans-serif);
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border-radius: var(--ha-card-border-radius, 16px);
        box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.15));
        overflow: hidden;
        color: var(--primary-text-color);
      }
      .header {
        padding: 14px 16px;
        background: var(--familyboard-header-background, linear-gradient(135deg, #F2A6A0, #F6D186));
        color: #2b2320;
      }
      .header-title { font-size: 1.2em; font-weight: 700; letter-spacing: 0.02em; margin-bottom: 8px; }
      .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
      .tool-group {
        display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.45);
        border-radius: 12px; padding: 4px 6px;
      }
      .tool-btn {
        border: none; background: none; font-size: 1.1em; line-height: 1; cursor: pointer;
        padding: 6px 8px; border-radius: 8px; color: #2b2320;
      }
      .tool-btn.active { background: rgba(255,255,255,0.9); box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
      .text-btn, .clear-btn { font-size: 0.85em; font-weight: 600; }
      .swatch {
        width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent;
        cursor: pointer; padding: 0;
      }
      .swatch.active { border-color: #2b2320; }
      .width-btn {
        width: 28px; height: 28px; border-radius: 8px; border: none; background: none;
        display: flex; align-items: center; justify-content: center; cursor: pointer;
      }
      .width-btn span { display: block; border-radius: 50%; background: #2b2320; }
      .width-btn.active { background: rgba(255,255,255,0.9); }
      .warning { padding: 10px 16px; color: var(--error-color, #db4437); }
      .warning[hidden] { display: none; }
      .board-wrap {
        position: relative;
        width: 100%;
        height: 480px;
        overflow: hidden;
        touch-action: none;
        background-color: var(--card-background-color, #fff);
        background-image: radial-gradient(circle, var(--divider-color, rgba(0,0,0,0.07)) 1px, transparent 1px);
        background-size: 22px 22px;
      }
      .board-canvas { position: absolute; inset: 0; touch-action: none; cursor: crosshair; }
      .notes-layer { position: absolute; inset: 0; pointer-events: none; }
      .note {
        position: absolute;
        width: 150px;
        min-height: 90px;
        border-radius: 6px;
        box-shadow: 0 3px 8px rgba(0,0,0,0.2);
        padding: 4px 8px 8px;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
      }
      .note-head { display: flex; align-items: center; justify-content: space-between; color: #2b2320; }
      .note-handle { cursor: grab; opacity: 0.6; font-size: 0.9em; touch-action: none; padding: 4px; }
      .note-delete {
        border: none; background: none; cursor: pointer; font-size: 0.75em; opacity: 0.6;
        color: #2b2320; padding: 4px;
      }
      .note-delete:hover { opacity: 1; }
      .note-text {
        flex: 1; font-size: 0.85em; line-height: 1.3; outline: none; word-break: break-word;
        white-space: pre-wrap; color: #2b2320;
      }
      .note-text:empty::before { content: attr(data-placeholder); opacity: 0.5; }
    </style>`;
  }
}

customElements.define("familyboard-whiteboard-card", FamilyboardWhiteboardCard);

const EDITOR_LABELS = {
  entity: "Entity",
  title: "Titel",
  height: "Höhe (Pixel)",
  language: "Sprache",
};

const EDITOR_HELPERS = {
  entity: "Sensor-Entity der Familyboard-Whiteboard-Integration",
};

class FamilyboardWhiteboardCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  _schema() {
    return [
      {
        name: "entity",
        required: true,
        selector: { entity: { filter: { integration: "familyboard_whiteboard" } } },
      },
      { name: "title", selector: { text: {} } },
      { name: "height", selector: { number: { min: 240, max: 1200, step: 20, mode: "box" } } },
      {
        name: "language",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "de", label: "Deutsch" },
              { value: "en", label: "English" },
            ],
          },
        },
      },
    ];
  }

  _render() {
    if (!this._hass || !this._config) return;

    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
      });
      this.appendChild(this._form);
    }

    this._form.hass = this._hass;
    this._form.data = { height: 480, language: "de", ...this._config };
    this._form.schema = this._schema();
    this._form.computeLabel = (item) => EDITOR_LABELS[item.name] || item.name;
    this._form.computeHelper = (item) => EDITOR_HELPERS[item.name] || "";
  }
}

customElements.define("familyboard-whiteboard-card-editor", FamilyboardWhiteboardCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "familyboard-whiteboard-card",
  name: "Familyboard Whiteboard Card",
  description: "Freihand-Zeichenbrett mit Stift, Radierer und Text-Notizen.",
  preview: false,
});
