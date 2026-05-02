const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let panel = null;
let liveState = null;
let activeCal = null;
let saveTimer = null;

const CT_MODELS = ["SCT-013-030", "SCT-013-100", "SCT-013-000", "SCT-024"];
const PORTS = Array.from({length: 12}, (_, i) => i + 1);
const MAINS_PORTS = new Set([1, 2]);
const HA_DEVICE_PREFIX = "sensor.energy_meter_58d5d4";

// ESPHome's slugify rule: lowercase, replace non-[a-z0-9] runs with _, trim _ from edges.
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
const CHIP_GROUPS = [
  { id: "meter_1_3", label: "Meter 1–3 (mains chip)", ports: [1, 2, 3] },
  { id: "meter_4_6", label: "Meter 4–6", ports: [4, 5, 6] },
  { id: "addon1_7_9", label: "Addon1 7–9", ports: [7, 8, 9] },
  { id: "addon1_10_12", label: "Addon1 10–12", ports: [10, 11, 12] },
];

function showError(msg) {
  const banner = $('#error-banner');
  banner.hidden = false;
  banner.textContent = msg;
}
function clearError() { $('#error-banner').hidden = true; }

// Spinner state — visible whenever any api() call is in flight. Counted, not
// boolean, because we may have several requests overlapping (e.g. cal wizard
// presses while the 5s refresh is also running).
let _inflight = 0;
function _spinnerInc() {
  _inflight++;
  const el = document.getElementById('loading-spinner');
  if (el) el.hidden = false;
}
function _spinnerDec() {
  _inflight = Math.max(0, _inflight - 1);
  if (_inflight === 0) {
    const el = document.getElementById('loading-spinner');
    if (el) el.hidden = true;
  }
}

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  _spinnerInc();
  let r;
  try {
    r = await fetch(path, opts);
  } catch (e) {
    _spinnerDec();
    throw new Error(`Cannot reach server (${path}).  ${e.message}`);
  }
  try {
    if (!r.ok) {
      let txt = '';
      try { txt = await r.text(); } catch {}
      throw new Error(`${method} ${path} → ${r.status}: ${txt}`);
    }
    const ct = r.headers.get('Content-Type') || '';
    return ct.includes('json') ? await r.json() : await r.text();
  } finally {
    _spinnerDec();
  }
}

async function init() {
  try {
    panel = await api("GET", "/api/panel");
  } catch (e) {
    showError(e.message);
    return;
  }
  $('#refresh').addEventListener('click', refresh);
  $('#add-ct').addEventListener('click', addCt);
  $('#snapshot').addEventListener('click', takeSnapshot);
  $('#export-yaml').addEventListener('click', exportYaml);
  $('#yaml-close').addEventListener('click', () => $('#yaml-dialog').close());
  $('#yaml-copy').addEventListener('click', copyYaml);
  $('#print-pdf').addEventListener('click', () => { buildPrintView(); window.print(); });
  // Notes modal handlers
  $('#notes-save').addEventListener('click', () => closeNotesModal(true));
  $('#notes-cancel').addEventListener('click', () => closeNotesModal(false));
  $('#notes-clear').addEventListener('click', () => { $('#notes-textarea').value = ''; $('#notes-textarea').focus(); });
  // Breaker edit modal handlers
  $('#bre-save').addEventListener('click', () => closeBreakerEdit(true));
  $('#bre-cancel').addEventListener('click', () => closeBreakerEdit(false));
  $('#breaker-edit-dialog').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      closeBreakerEdit(true);
    }
  });
  await refresh();
  renderAll();
  setInterval(refresh, 5000);
}

// === Notes modal — shared between CTs and breakers ==========================
let notesEditTarget = null;

function openNotesModal({ obj, key, label, onSave }) {
  notesEditTarget = { obj, key, onSave };
  $('#notes-dialog-title').textContent = `Notes — ${label}`;
  $('#notes-textarea').value = obj[key] || '';
  $('#notes-dialog').showModal();
  setTimeout(() => $('#notes-textarea').focus(), 30);
}

function closeNotesModal(save) {
  if (save && notesEditTarget) {
    const { obj, key, onSave } = notesEditTarget;
    obj[key] = $('#notes-textarea').value.trim();
    if (onSave) onSave();
  }
  $('#notes-dialog').close();
  notesEditTarget = null;
}

function userIsEditing() {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return true;
  if (document.querySelector('.edit-row')) return true;
  if (document.querySelector('dialog[open]')) return true;
  return false;
}

async function refresh() {
  try {
    liveState = await api("GET", "/api/state");
    clearError();
    $('#v1').textContent = fmt(liveState.voltage1, 2);
    $('#freq').textContent = fmt(liveState.freq, 2);
    $('#total-w').textContent = fmt(liveState.totalWatts, 0);
    $('#total-a').textContent = fmt(liveState.totalAmps, 1);
    const reset = liveState.resetReason || '';
    const isAbnormal = reset && !/^(POWERON|RTC_RESET|reset_reason_unknown|UNKNOWN)$/i.test(reset);
    $('#reset-stat').hidden = !isAbnormal;
    $('#reset').textContent = reset;
    $('#reset-stat').classList.toggle('alert', isAbnormal);

    const port1 = liveState.byPort?.['1'];
    const port2 = liveState.byPort?.['2'];
    if (port1 && port2) {
      $('#mains').textContent = (parseFloat(port1.amps || 0) + parseFloat(port2.amps || 0)).toFixed(1);
    }
    $('#updated').textContent = "updated " + new Date().toLocaleTimeString();
    if (activeCal) {
      $('#cal-live-v').textContent = fmt(liveState.voltage1, 2);
      const p = getPortData(activeCal.ct.port);
      if (p) $('#cal-raw').textContent = `${fmt(p.amps, 4)} A / ${fmt(p.watts, 2)} W`;
    }
    if (userIsEditing()) {
      $('#updated').textContent += " (paused: editing)";
    } else {
      renderAll();
    }
  } catch (e) {
    showError(e.message);
    $('#updated').textContent = "ERROR " + new Date().toLocaleTimeString();
  }
}

function fmt(v, decimals = 2) {
  if (v === null || v === undefined || v === '') return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return String(v);
  return n.toFixed(decimals);
}

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function openCtNotesModal(ct) {
  openNotesModal({
    obj: ct,
    key: 'notes',
    label: `${ct.tapeLabel ? '[' + ct.tapeLabel + '] ' : ''}${ct.label || ct.id} (port ${ct.port ?? '—'})`,
    onSave: () => { markDirty(`notes on ${ct.id}`); renderAll(); }
  });
}

function buildCtNotesSubrow(ct, totalCols) {
  if (!ct.notes) return null;
  const tr = document.createElement('tr');
  tr.className = 'ct-notes-subrow';
  tr.dataset.ctId = ct.id;
  tr.innerHTML = `
    <td colspan="${totalCols}" class="notes-subrow-cell">
      <span class="notes-subrow-label">📝 NOTE</span>
      <span class="notes-subrow-text">${escapeHtml(ct.notes)}</span>
      <button class="notes-subrow-edit secondary">edit</button>
    </td>
  `;
  tr.querySelector('.notes-subrow-edit').addEventListener('click', () => openCtNotesModal(ct));
  // Clicking anywhere in the cell also opens the editor
  tr.querySelector('.notes-subrow-cell').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    openCtNotesModal(ct);
  });
  return tr;
}

function getCt(id) { return panel.cts.find(c => c.id === id) || null; }
function getCtByPort(port) { return panel.cts.find(c => c.port === port) || null; }
function getPortData(port) { return liveState?.byPort?.[String(port)] || null; }
function getBreakerForCt(ctId) {
  for (const side of ['left', 'right']) {
    for (const b of panel[side]) if (b.ctId === ctId) return { side, pos: b.pos };
  }
  return null;
}
function isCtAssignedToBreaker(ctId) { return !!getBreakerForCt(ctId); }

function liveBadge(port) {
  const p = getPortData(port);
  if (!p) return { aHtml: '—', wHtml: '—', refV: '—', refI: '—' };
  const a = parseFloat(p.amps);
  const w = parseFloat(p.watts);
  const aClass = isFinite(a) && Math.abs(a) > 0.05 ? 'active' : 'zero';
  const wClass = isFinite(w) && Math.abs(w) > 1 ? 'active' : 'zero';
  return {
    aHtml: `<span class="live ${aClass}">${isFinite(a) ? a.toFixed(2) + ' A' : '—'}</span>`,
    wHtml: `<span class="live ${wClass}">${isFinite(w) ? w.toFixed(0) + ' W' : '—'}</span>`,
    refV: p.refV ?? '—',
    refI: p.refCurrent ?? '—',
  };
}

function compactCtRow(ct) {
  const port = ct.port;
  const lb = port ? liveBadge(port) : { aHtml: '—', wHtml: '—' };
  const tape = ct.tapeLabel ? `<span class="bk-ct-tape">${escapeHtml(ct.tapeLabel)}</span>` : '';
  const portTag = port ? `p${port}` : 'no port';
  return `
    <div class="bk-field bk-ct-line">
      <span class="bk-field-label">CT</span>
      ${tape}
      <span class="bk-ct-name">${escapeHtml(ct.label || ct.id)}</span>
      <span class="bk-ct-port">${portTag}</span>
      <span class="bk-ct-live">${lb.aHtml}${lb.wHtml}</span>
      <button class="btn-cal" data-ct-id="${ct.id}" ${port ? '' : 'disabled'}>Cal</button>
    </div>
  `;
}

// Standalone CT card for the Mains and Unassigned rows (not inside a breaker).
function compactCtCard(ct) {
  const port = ct.port;
  const lb = port ? liveBadge(port) : { aHtml: '—', wHtml: '—' };
  const tape = ct.tapeLabel ? `<span class="bk-ct-tape">${escapeHtml(ct.tapeLabel)}</span>` : '';
  const portTag = port ? `p${port}` : 'no port';
  const assigned = getBreakerForCt(ct.id);
  const assignedTag = assigned ? `<span class="ct-card-asg">${assigned.side[0].toUpperCase()}${assigned.pos}</span>` : '';
  return `
    <div class="compact-ct" data-ct-id="${ct.id}">
      <div class="compact-ct-row1">
        ${tape}
        <span class="compact-ct-name">${escapeHtml(ct.label || ct.id)}</span>
        <span class="bk-ct-port">${portTag}</span>
        ${assignedTag}
      </div>
      <div class="compact-ct-row2">
        ${lb.aHtml}${lb.wHtml}
        <button class="btn-cal" data-ct-id="${ct.id}" ${port ? '' : 'disabled'}>Cal</button>
      </div>
    </div>
  `;
}

function renderAll() {
  if (!panel) return;
  renderInventory();
  renderMains();
  renderBreakers();
  renderUnassigned();
}

// === Calibration state helpers (used inside inventory groups) ==============
function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const dt = Date.now() - t;
  if (dt < 0) return new Date(iso).toLocaleString();
  const s = Math.floor(dt / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

function isCalPressed(buttonInfo) {
  // Buttons that have been pressed have state = ISO timestamp; never-pressed = "unknown".
  return buttonInfo?.state && buttonInfo.state !== 'unknown';
}

function calStateLabel(chip) {
  const b = chip.buttons || {};
  const offsetDone   = isCalPressed(b.offset_run);
  const pwrOffDone   = isCalPressed(b.power_offset_run);
  const gainDone     = isCalPressed(b.gain_run);
  const offsetClear  = isCalPressed(b.offset_clear);
  const pwrOffClear  = isCalPressed(b.power_offset_clear);
  const gainClear    = isCalPressed(b.gain_clear);
  // Did each Run happen AFTER its Clear?
  const after = (run, clr) => {
    if (!isCalPressed(run)) return false;
    if (!isCalPressed(clr)) return true; // never cleared, so any run wins
    return new Date(run.state).getTime() > new Date(clr.state).getTime();
  };
  const offsetActive = after(b.offset_run, b.offset_clear);
  const pwrOffActive = after(b.power_offset_run, b.power_offset_clear);
  const gainActive   = after(b.gain_run, b.gain_clear);
  if (offsetActive && pwrOffActive && gainActive) return { label: 'CALIBRATED', cls: 'cal-state-good' };
  if (offsetActive || pwrOffActive || gainActive)  return { label: 'PARTIAL',    cls: 'cal-state-partial' };
  if (offsetClear || pwrOffClear || gainClear)     return { label: 'CLEARED',    cls: 'cal-state-cleared' };
  return                                                  { label: 'NEVER CAL\'D', cls: 'cal-state-none' };
}

function calStepState(runBtn, clrBtn) {
  const runT = isCalPressed(runBtn) ? new Date(runBtn.state).getTime() : 0;
  const clrT = isCalPressed(clrBtn) ? new Date(clrBtn.state).getTime() : 0;
  if (!runT && !clrT) return { kind: 'never', label: 'Never run', time: null };
  if (runT > clrT)    return { kind: 'active', label: 'Active', time: new Date(runT).toISOString() };
  return { kind: 'cleared', label: 'Cleared', time: new Date(clrT).toISOString() };
}

function buildCalHeader(chipId) {
  const chip = liveState?.byChip?.[chipId];
  if (!chip) return '<div class="cal-header-strip muted">no live chip data</div>';
  const status = calStateLabel(chip);
  const voltCal = liveState?.yamlVoltCal?.[chip.vsuf] || '—';
  const refVDisplay = chip.refV === 'unknown' || !chip.refV
    ? '<span class="muted">not set</span>'
    : `<strong>${escapeHtml(String(chip.refV))} V</strong>`;

  const stepPill = (label, runBtn, clrBtn) => {
    const s = calStepState(runBtn, clrBtn);
    const cls = `cal-step cal-step-${s.kind}`;
    const icon = s.kind === 'active' ? '✓' : s.kind === 'cleared' ? '⊘' : '○';
    const when = s.time ? `<span class="cal-step-time">${relTime(s.time)}</span>` : '';
    return `<span class="${cls}" title="${s.label}: ${s.time ? new Date(s.time).toLocaleString() : 'never pressed'}">${icon} ${label} ${when}</span>`;
  };

  return `
    <div class="cal-header-strip">
      <div class="cal-header-row1">
        <span class="cal-state-badge ${status.cls}">${status.label}</span>
        ${chip.chipTemp ? `<span class="muted">🌡 ${fmt(chip.chipTemp, 1)}°F</span>` : ''}
        <span class="hdr-spacer"></span>
        <button class="primary cal-wiz-btn" data-wiz-chip="${chipId}" title="Step-by-step calibration with prompts and live readings">🧙 Cal Wizard</button>
        <button class="warn cal-clear-btn" data-clear-chip="${chipId}" title="Press the three z*_clear buttons on this chip — wipes runtime offset/gain so chip falls back to YAML constants">Clear all cal</button>
      </div>
      <div class="cal-header-row2">
        <div class="cal-block">
          <span class="cal-block-title">Per-chip <span class="src-tag src-yaml">YAML</span></span>
          <span class="cal-kv"><span class="k">voltage_cal${chip.vsuf}</span> <span class="v">${voltCal}</span></span>
        </div>
        <div class="cal-block">
          <span class="cal-block-title">Per-chip <span class="src-tag src-ha">HA runtime</span></span>
          <span class="cal-kv"><span class="k">Ref V (V${chip.vsuf})</span> <span class="v">${refVDisplay}</span>
            ${chip.refVChanged ? `<span class="muted">${relTime(chip.refVChanged)}</span>` : ''}</span>
        </div>
        <div class="cal-block cal-block-steps">
          <span class="cal-block-title">Per-channel cal steps <span class="src-tag src-ha">HA buttons</span>
            <span class="muted" title="The chip stores the actual gain/offset coefficients internally — not exposed by the firmware. Only the input you set (Ref V, Ref I) and whether the button has been pressed are visible.">ⓘ</span>
          </span>
          <div class="cal-steps">
            ${stepPill('Offset',     chip.buttons.offset_run,        chip.buttons.offset_clear)}
            ${stepPill('Pwr Offset', chip.buttons.power_offset_run,  chip.buttons.power_offset_clear)}
            ${stepPill('Gain',       chip.buttons.gain_run,          chip.buttons.gain_clear)}
          </div>
        </div>
      </div>
    </div>
  `;
}

// === Calibration Wizard =====================================================
let wizard = null;

function openWizard(chipId) {
  const chip = liveState?.byChip?.[chipId];
  if (!chip) return showError('No chip data — server unreachable?');
  wizard = {
    chipId,
    chip,
    step: 0,
    refV: parseFloat(liveState?.voltage1 || 0).toFixed(2),
    refI: {}, // port -> measured A
    portsToCal: chip.ports.slice(),
    log: [],
  };
  $('#wiz-back').onclick = wizPrev;
  $('#wiz-next').onclick = wizNext;
  $('#wiz-skip').onclick = () => { wizSkipPort(); };
  $('#wiz-close').onclick = wizClose;
  $('#wizard-dialog').showModal();
  wizRender();
}

function wizClose() {
  $('#wizard-dialog').close();
  wizard = null;
  refresh();
}

function wizLog(msg) {
  if (!wizard) return;
  const ts = new Date().toLocaleTimeString();
  wizard.log.push(`[${ts}] ${msg}`);
  const log = $('#wiz-log');
  log.textContent = wizard.log.join('\n');
  log.scrollTop = log.scrollHeight;
}

function wizPortGainStepIndex(port) {
  // Steps: 0 welcome, 1 refV, 2 clear, 3 offset, 4 power-offset, 5..(5+n-1) per-port gain, last summary
  return 5 + wizard.portsToCal.indexOf(port);
}

function wizSummaryStepIndex() { return 5 + wizard.portsToCal.length; }

function wizTotalSteps() { return wizSummaryStepIndex() + 1; }

function wizGetCurrentPortGain() {
  const idx = wizard.step - 5;
  if (idx < 0 || idx >= wizard.portsToCal.length) return null;
  return wizard.portsToCal[idx];
}

function wizRender() {
  const w = wizard;
  if (!w) return;
  $('#wiz-progress').textContent = `Step ${w.step + 1} of ${wizTotalSteps()}`;
  $('#wiz-skip').hidden = true;
  $('#wiz-skip').textContent = 'Skip';
  const body = $('#wiz-body');
  const chip = w.chip;
  const portList = chip.ports.map(p => {
    const ct = getCtByPort(p);
    return `port ${p} (${ct ? escapeHtml(ct.label || ct.id) : 'unassigned'})`;
  }).join(', ');

  if (w.step === 0) {
    // Welcome
    $('#wiz-title').textContent = `Calibrate ${chip.label}`;
    $('#wiz-back').disabled = true;
    body.innerHTML = `
      <div class="wiz-step">
        <h4>What this wizard does</h4>
        <p>You're about to calibrate <strong>${escapeHtml(chip.label)}</strong> (V${chip.vsuf}). It covers ${portList}.</p>
        <p>The wizard will walk through, in order:</p>
        <ol class="wiz-list">
          <li><strong>Set voltage reference</strong> — tell the chip the real line voltage on V${chip.vsuf}.</li>
          <li><strong>Clear existing cal</strong> — wipe any runtime offset/gain, fall back to YAML defaults.</li>
          <li><strong>Offset cal (no load)</strong> — measure the chip's noise floor with all 3 ports at zero current.</li>
          <li><strong>Power-offset cal (no load)</strong> — same conditions, calibrates the watts baseline.</li>
          <li><strong>Gain cal per port</strong> — for each port, turn on a steady reference load, measure with your clamp meter, type the value, apply.</li>
        </ol>
        <p class="wiz-hint">Time required: ~5–10 minutes. You'll need a clamp meter for the gain step. You can skip any port's gain cal if there's no convenient load.</p>
      </div>
    `;
    $('#wiz-next').textContent = 'Begin →';
    $('#wiz-hint').textContent = '';
    return;
  }

  if (w.step === 1) {
    // Set Ref V
    $('#wiz-title').textContent = `Step 1: Voltage reference`;
    $('#wiz-back').disabled = false;
    const liveV = parseFloat(liveState?.voltage1 || 0).toFixed(2);
    body.innerHTML = `
      <div class="wiz-step">
        <h4>Set voltage reference for V${chip.vsuf}</h4>
        <p>The chip needs to know the actual AC line voltage on its V${chip.vsuf} input so it can compute watts correctly. Two ways to get this number:</p>
        <ol class="wiz-list">
          <li><strong>Measure with a multimeter</strong> at the panel between L${chip.vsuf} and neutral. Most accurate.</li>
          <li><strong>Use the chip's current live reading</strong> — V1 currently reports <strong>${liveV} V</strong>. Good enough for normal cal.</li>
        </ol>
        <div class="wiz-input-row">
          <label>Ref V (V${chip.vsuf}): <input type="number" step="0.01" id="wiz-ref-v" value="${w.refV}"></label>
          <button class="secondary" id="wiz-use-live-v">Use live V1 (${liveV})</button>
        </div>
        <p class="wiz-hint">Click Continue to write this value to <code>number.energy_meter_58d5d4_${w.chipId}_ref_v_${chip.vsuf}</code>.</p>
      </div>
    `;
    $('#wiz-use-live-v').onclick = () => {
      $('#wiz-ref-v').value = parseFloat(liveState?.voltage1 || 0).toFixed(2);
      w.refV = $('#wiz-ref-v').value;
    };
    $('#wiz-next').textContent = 'Set & Continue →';
    return;
  }

  if (w.step === 2) {
    // Clear cal
    $('#wiz-title').textContent = `Step 2: Clear existing cal`;
    const status = calStateLabel(chip);
    body.innerHTML = `
      <div class="wiz-step">
        <h4>Clear runtime cal on this chip</h4>
        <p>Wipes the three runtime cal slots (offset, power-offset, gain) so we start from the YAML boot constants. Pressing Continue will press these three buttons in order:</p>
        <ul class="wiz-list">
          <li><code>z1_clear_${w.chipId}_offset_cal</code></li>
          <li><code>z2_clear_${w.chipId}_power_offset_cal</code></li>
          <li><code>z3_clear_${w.chipId}_gain_cal</code></li>
        </ul>
        <p>Current chip status: <span class="cal-state-badge ${status.cls}">${status.label}</span></p>
      </div>
    `;
    $('#wiz-next').textContent = 'Clear all cal →';
    return;
  }

  if (w.step === 3 || w.step === 4) {
    // Offset / power-offset — no-load
    const isOffset = w.step === 3;
    $('#wiz-title').textContent = `Step ${w.step}: ${isOffset ? 'Offset' : 'Power-offset'} cal (no load)`;
    const portRows = chip.ports.map(p => {
      const pd = getPortData(p);
      const ct = getCtByPort(p);
      const a = pd ? parseFloat(pd.amps) : NaN;
      const ok = isFinite(a) && Math.abs(a) < 0.05;
      return `
        <tr>
          <td>port ${p}</td>
          <td>${ct ? escapeHtml(ct.label || ct.id) : '<em>unassigned</em>'}</td>
          <td class="${ok ? 'cal-status-ok' : 'cal-status-bad'}">
            ${isFinite(a) ? a.toFixed(3) : '—'} A ${ok ? '✓' : '⚠'}
          </td>
          <td>${ct?.tapeLabel ? '<span class="bk-ct-tape">'+escapeHtml(ct.tapeLabel)+'</span>' : ''}</td>
        </tr>
      `;
    }).join('');
    const isMainsChip = chip.ports.includes(1) || chip.ports.includes(2);
    body.innerHTML = `
      <div class="wiz-step">
        <h4>${isOffset ? 'Offset' : 'Power-offset'}: turn off all loads on this chip</h4>
        <p>Make sure <strong>none</strong> of the circuits below have current flowing. The chip needs a true zero baseline to lock in.</p>
        <p>Live amps for each port (updates every ${5}s):</p>
        <table class="wiz-port-table">
          <thead><tr><th>Port</th><th>CT</th><th>Live amps</th><th>Tape</th></tr></thead>
          <tbody>${portRows}</tbody>
        </table>
        <p class="wiz-hint">All values should be under <strong>0.05 A</strong> (the green-check threshold). If a port still has draw, find what's on that circuit and turn it off, then wait for the next refresh.</p>
        ${isMainsChip ? `
        <div class="wiz-hint" style="background:#fee2e2; border-left-color:#ef4444;">
          <strong>Mains chip caveat:</strong> getting CT1 and CT2 to zero usually means cutting power to the house — which kills this meter. Three options:
          <ul class="wiz-list" style="margin:6px 0;">
            <li><strong>Skip this step</strong> — accept a small (~1–2%) offset error on mains. Plenty accurate for energy totals.</li>
            <li><strong>Lift the CT clamps</strong> off the L1 and L2 wires temporarily (they're safe to open on live wire — TVS-protected); flip the fridge breaker too. Then run cal. Re-clamp after.</li>
            <li><strong>UPS the meter</strong> so it stays alive when you cut the main.</li>
          </ul>
        </div>` : ''}
        ${!isOffset ? '<p>This step also requires no load — same conditions as the previous step.</p>' : ''}
      </div>
    `;
    $('#wiz-next').textContent = `Run ${isOffset ? 'offset' : 'power-offset'} cal →`;
    $('#wiz-skip').hidden = false;
    $('#wiz-skip').textContent = `Skip this step`;
    return;
  }

  if (w.step >= 5 && w.step < wizSummaryStepIndex()) {
    // Per-port gain cal
    const port = wizGetCurrentPortGain();
    const pd = getPortData(port);
    const ct = getCtByPort(port);
    const idx = w.step - 5;
    $('#wiz-title').textContent = `Step ${4 + idx + 1}: Gain cal — port ${port}`;
    $('#wiz-skip').hidden = false;
    const liveA = pd ? parseFloat(pd.amps) : NaN;
    const liveW = pd ? parseFloat(pd.watts) : NaN;
    const ctName = ct ? `${ct.tapeLabel ? '['+escapeHtml(ct.tapeLabel)+'] ' : ''}${escapeHtml(ct.label || ct.id)}` : '<em>unassigned</em>';
    body.innerHTML = `
      <div class="wiz-step">
        <h4>Gain cal — port ${port}: ${ctName}</h4>
        <p>Turn on a steady load on this circuit. The bigger and more stable, the better the cal.</p>
        <ol class="wiz-list">
          <li>Switch on the load (e.g. dryer at full heat, hot water heater element, kitchen oven, etc.).</li>
          <li>Use your clamp meter at the panel on the wire this CT is around. Wait until the reading is steady.</li>
          <li>Type that exact reading below.</li>
        </ol>
        <div class="wiz-port-readout">
          <div>Chip currently reads on this port:</div>
          <div class="wiz-live-big">
            <span class="live ${Math.abs(liveA) > 0.05 ? 'active' : 'zero'}">${isFinite(liveA) ? liveA.toFixed(3) : '—'} A</span>
            <span class="live ${Math.abs(liveW) > 1 ? 'active' : 'zero'}">${isFinite(liveW) ? liveW.toFixed(1) : '—'} W</span>
          </div>
          <div class="muted">If the chip reading is much smaller than your clamp meter — that's normal pre-cal; the gain step will fix that.</div>
        </div>
        <div class="wiz-input-row">
          <label>Your clamp meter reading: <input type="number" step="0.01" id="wiz-ref-i" value="${w.refI[port] ?? ''}" placeholder="A"></label>
        </div>
        <p class="wiz-hint">If you don't have a load you can turn on right now, click Skip — that port's gain stays at the YAML default.</p>
      </div>
    `;
    $('#wiz-next').textContent = 'Apply gain cal →';
    return;
  }

  if (w.step === wizSummaryStepIndex()) {
    // Summary
    $('#wiz-title').textContent = `Calibration complete`;
    $('#wiz-skip').hidden = true;
    $('#wiz-back').disabled = true;
    const summary = [];
    summary.push(`<li><strong>Ref V (V${chip.vsuf})</strong>: set to <code>${w.refV}</code></li>`);
    summary.push(`<li><strong>Cleared</strong>: offset, power-offset, gain</li>`);
    summary.push(`<li><strong>Offset cal</strong>: applied (no load)</li>`);
    summary.push(`<li><strong>Power-offset cal</strong>: applied (no load)</li>`);
    for (const port of chip.ports) {
      const v = w.refI[port];
      if (v === 'skipped') {
        summary.push(`<li>Port ${port}: gain cal <em>skipped</em></li>`);
      } else if (v !== undefined) {
        summary.push(`<li>Port ${port}: gain cal applied at <code>${v} A</code> reference</li>`);
      } else {
        summary.push(`<li>Port ${port}: <em>not reached</em></li>`);
      }
    }
    body.innerHTML = `
      <div class="wiz-step">
        <h4>Done — ${escapeHtml(chip.label)}</h4>
        <p>Summary of actions written to the device:</p>
        <ul class="wiz-list">${summary.join('')}</ul>
        <p>Live readings will catch up on the next 5 s refresh after closing.</p>
      </div>
    `;
    $('#wiz-next').textContent = 'Close';
    return;
  }
}

async function wizNext() {
  const w = wizard;
  if (!w) return;
  const chip = w.chip;
  try {
    if (w.step === 0) {
      w.step = 1; wizRender(); return;
    }
    if (w.step === 1) {
      const v = parseFloat($('#wiz-ref-v').value);
      if (isNaN(v)) return showError('Enter a number for Ref V');
      await api("POST", "/api/cal/set-ref-v", { chip: w.chipId, vsuf: chip.vsuf, value: v });
      w.refV = v;
      wizLog(`✓ Ref V (V${chip.vsuf}) ← ${v}`);
      await api("POST", "/api/log", { msg: `wizard: ref V ${v} on ${w.chipId}` });
      w.step = 2; wizRender(); return;
    }
    if (w.step === 2) {
      for (const a of ['gain_clear', 'power_offset_clear', 'offset_clear']) {
        await api("POST", "/api/cal/press", { action: a, chip: w.chipId });
        wizLog(`✓ pressed ${a}`);
      }
      await api("POST", "/api/log", { msg: `wizard: cleared all cal on ${w.chipId}` });
      w.step = 3; wizRender(); refresh(); return;
    }
    if (w.step === 3) {
      await api("POST", "/api/cal/press", { action: 'offset_run', chip: w.chipId });
      wizLog(`✓ offset_run pressed`);
      await new Promise(r => setTimeout(r, 1500));
      await api("POST", "/api/log", { msg: `wizard: offset_run on ${w.chipId}` });
      w.step = 4; wizRender(); refresh(); return;
    }
    if (w.step === 4) {
      await api("POST", "/api/cal/press", { action: 'power_offset_run', chip: w.chipId });
      wizLog(`✓ power_offset_run pressed`);
      await new Promise(r => setTimeout(r, 1500));
      await api("POST", "/api/log", { msg: `wizard: power_offset_run on ${w.chipId}` });
      w.step = 5; wizRender(); refresh(); return;
    }
    if (w.step >= 5 && w.step < wizSummaryStepIndex()) {
      const port = wizGetCurrentPortGain();
      const pd = getPortData(port);
      const v = parseFloat($('#wiz-ref-i').value);
      if (isNaN(v)) return showError('Enter your clamp meter reading (A)');
      await api("POST", "/api/cal/set-ref-current", { slug: pd.slug, value: v });
      wizLog(`✓ Ref I ← ${v} on port ${port} (${pd.slug})`);
      await api("POST", "/api/cal/press", { action: 'gain_run', chip: w.chipId });
      wizLog(`✓ gain_run pressed (refI=${v} on port ${port})`);
      await api("POST", "/api/log", { msg: `wizard: gain_run on ${w.chipId} port ${port} ref ${v}A` });
      w.refI[port] = v;
      await new Promise(r => setTimeout(r, 1500));
      w.step++; wizRender(); refresh(); return;
    }
    if (w.step === wizSummaryStepIndex()) {
      wizClose();
      return;
    }
  } catch (e) {
    showError('Wizard step failed: ' + e.message);
  }
}

function wizPrev() {
  if (!wizard) return;
  if (wizard.step > 0) {
    wizard.step--;
    wizRender();
  }
}

async function wizSkipPort() {
  if (!wizard) return;
  if (wizard.step === 3) {
    wizLog('offset cal SKIPPED for this chip');
    wizard.step = 4;
    wizRender();
    return;
  }
  if (wizard.step === 4) {
    wizLog('power-offset cal SKIPPED for this chip');
    wizard.step = 5;
    wizRender();
    return;
  }
  if (wizard.step >= 5 && wizard.step < wizSummaryStepIndex()) {
    const port = wizGetCurrentPortGain();
    wizard.refI[port] = 'skipped';
    wizLog(`port ${port} gain cal skipped`);
    wizard.step++;
    wizRender();
  }
}

async function clearChipCal(chipId) {
  if (!confirm(`Clear ALL calibration (offset, power-offset, gain) on chip "${chipId}"?\n\nThis presses the three z*_clear buttons. The chip will revert to whatever runtime cal was stored before, falling back to the YAML boot constants.`)) return;
  try {
    for (const a of ['gain_clear', 'power_offset_clear', 'offset_clear']) {
      await api("POST", "/api/cal/press", { action: a, chip: chipId });
    }
    await api("POST", "/api/log", { msg: `cleared all cal on chip ${chipId} via panel-tool` });
    await refresh();
  } catch (e) {
    showError(e.message);
  }
}

function renderInventory() {
  const container = $('#ct-inventory-groups');
  container.innerHTML = '';
  // Detect duplicate ports for warnings
  const portCounts = {};
  for (const c of panel.cts) {
    if (c.port) portCounts[c.port] = (portCounts[c.port] || 0) + 1;
  }
  const dupes = Object.keys(portCounts).filter(p => portCounts[p] > 1);
  $('#inventory-warnings').textContent = dupes.length ? `⚠ Multiple CTs on port(s): ${dupes.join(', ')} — only the first will read live data.` : '';

  // Group by chip; CTs with no port go into a separate "spare" group at the end.
  const grouped = new Map();
  for (const g of CHIP_GROUPS) grouped.set(g.id, []);
  const spares = [];
  for (const ct of panel.cts) {
    const g = CHIP_GROUPS.find(g => g.ports.includes(ct.port));
    if (g) grouped.get(g.id).push(ct); else spares.push(ct);
  }

  for (const g of CHIP_GROUPS) {
    container.appendChild(buildInventoryGroup(g.label, grouped.get(g.id), g.ports, g.id));
  }
  if (spares.length) {
    container.appendChild(buildInventoryGroup("Spares (no port assigned)", spares, [], null));
  }
  // Hook clear-cal buttons (delegated)
  $$('button[data-clear-chip]', container).forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      clearChipCal(b.dataset.clearChip);
    });
  });
  $$('button[data-wiz-chip]', container).forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      openWizard(b.dataset.wizChip);
    });
  });
}

function buildInventoryGroup(title, cts, ports, chipId) {
  const div = document.createElement('div');
  div.className = 'inv-group';
  const calHeader = chipId ? buildCalHeader(chipId) : '';
  div.innerHTML = `
    <div class="inv-group-head">
      <h4>${escapeHtml(title)}</h4>
    </div>
    ${calHeader}
  `;
  const table = document.createElement('table');
  table.className = 'inv-table';
  table.innerHTML = `
    <thead>
      <tr class="hdr-section">
        <th colspan="5" class="hdr-grp hdr-grp-id">CT identity</th>
        <th colspan="2" class="hdr-grp hdr-grp-yaml">Set in YAML <span class="src-tag src-yaml">YAML</span></th>
        <th colspan="1" class="hdr-grp hdr-grp-ha">Set via HA <span class="src-tag src-ha">HA</span></th>
        <th colspan="3" class="hdr-grp hdr-grp-live">Live (read-only)</th>
        <th colspan="1" class="hdr-grp hdr-grp-meta">Meta</th>
        <th></th>
      </tr>
      <tr>
        <th style="width:6%" title="Sticker on the physical CT">Tape</th>
        <th style="width:18%" title="Literal line in energy_meter.yaml under substitutions:">YAML <code>ctN_name:</code></th>
        <th style="width:15%" title="Auto-derived HA entity slug (sensor.energy_meter_58d5d4_&lt;slug&gt;_*)">HA entity</th>
        <th style="width:8%">Model</th>
        <th style="width:5%">Port</th>
        <th style="width:6%" title="Boot-time current_cal_ctN gain constant from YAML — controls how raw chip amps map to actual amps">Cur cal</th>
        <th style="width:5%" title="YAML power filter — multiply factor on the wattage (×−2 for 240V single-leg, ×−1 for reversed clamp)">Pwr mult</th>
        <th style="width:7%" title="Runtime gain-cal Ref Current value (HA number entity, persisted on the ESP)">Ref I</th>
        <th style="width:5%" title="Status sensor reported by the chip">Status</th>
        <th style="width:7%" title="Live amps">Live A</th>
        <th style="width:7%" title="Live watts">Live W</th>
        <th style="width:6%" title="Breaker this CT is mapped to">Asg</th>
        <th style="width:5%"></th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  cts.sort((a, b) => (a.port || 99) - (b.port || 99));
  for (const ct of cts) {
    tbody.appendChild(buildInventoryRow(ct));
    const subRow = buildCtNotesSubrow(ct, 13);
    if (subRow) tbody.appendChild(subRow);
  }
  div.appendChild(table);
  return div;
}

function haEntityCellHTML(ct) {
  const futureSlug = slugify(ct.label) || '<unset>';
  const port = ct.port;
  const liveSlug = port ? getPortData(port)?.slug : null;
  // The slug currently flashed on the firmware (what HA actually uses NOW)
  // is whatever the YAML had at the most recent flash, exposed through the live state's slug.
  if (liveSlug && liveSlug !== futureSlug) {
    return `
      <div class="ha-entity">
        <div><span class="ha-host">${HA_DEVICE_PREFIX}_</span><strong class="ha-slug">${escapeHtml(liveSlug)}</strong><span class="ha-host">_*</span></div>
        <div class="ha-future">⤴ on next flash: <strong>${escapeHtml(futureSlug)}</strong></div>
      </div>
    `;
  }
  return `<div class="ha-entity"><span class="ha-host">${HA_DEVICE_PREFIX}_</span><strong class="ha-slug">${escapeHtml(futureSlug)}</strong><span class="ha-host">_*</span></div>`;
}

function buildInventoryRow(ct) {
  const tr = document.createElement('tr');
  tr.dataset.ctId = ct.id;
  const lb = ct.port ? liveBadge(ct.port) : { aHtml: '—', wHtml: '—' };
  const portOptions = ['<option value="">— none —</option>',
    ...PORTS.map(p => {
      const occ = panel.cts.find(c => c.port === p && c.id !== ct.id);
      const tag = occ ? ` (used by ${occ.label || occ.id})` : '';
      return `<option value="${p}" ${ct.port === p ? 'selected' : ''}>${p}${tag}</option>`;
    })
  ];
  const assigned = getBreakerForCt(ct.id);
  const assignedTxt = assigned ? `${assigned.side[0].toUpperCase()}${assigned.pos}` : '—';
  const portData = ct.port ? getPortData(ct.port) : null;
  const yamlCalConst = liveState?.yamlCal?.[String(ct.port)] || '—';
  const yamlMult = ct.port ? liveState?.yamlPowerMult?.[String(ct.port)] : null;
  const multDisplay = yamlMult === null || yamlMult === undefined
    ? '—'
    : (yamlMult === 1 ? `<span class="muted">×1</span>` : `<strong>×${yamlMult}</strong>`);
  const refI = portData?.refCurrent;
  const refIDisplay = (refI === undefined || refI === null || refI === 'unknown')
    ? '<span class="muted">unset</span>'
    : escapeHtml(String(refI));
  const refIChanged = portData?.refCurrentChanged;
  const statusVal = portData?.status || '—';
  const statusClass = statusVal === 'Okay' ? 'cal-status-ok' : (statusVal === '—' ? 'muted' : 'cal-status-bad');
  const ctNamePrefix = ct.port ? `<span class="yaml-key">ct${ct.port}_name:</span>` : '<span class="yaml-key muted">no port</span>';
  tr.innerHTML = `
    <td><input type="text" class="inv-tape" value="${escapeHtml(ct.tapeLabel || '')}" placeholder="(tape)"></td>
    <td class="yaml-name-cell">
      ${ctNamePrefix}
      <input type="text" class="inv-label" value="${escapeHtml(ct.label || '')}" placeholder="(value)">
    </td>
    <td class="ha-entity-cell">${haEntityCellHTML(ct)}</td>
    <td>
      <select class="inv-model">
        ${CT_MODELS.map(m => `<option ${m===ct.model?'selected':''}>${m}</option>`).join('')}
      </select>
    </td>
    <td><select class="inv-port">${portOptions.join('')}</select></td>
    <td class="inv-yamlcal" title="current_cal_ct${ct.port || '?'} in YAML">${yamlCalConst}</td>
    <td class="inv-mult" title="Multiply filter applied to this CT's power reading in the YAML">${multDisplay}</td>
    <td class="inv-refi">${refIDisplay}${refIChanged && refI !== 'unknown' ? `<div class="muted ref-time">${relTime(refIChanged)}</div>` : ''}</td>
    <td class="${statusClass}">${escapeHtml(statusVal)}</td>
    <td>${lb.aHtml}</td>
    <td>${lb.wHtml}</td>
    <td class="inv-assigned">${assignedTxt}</td>
    <td class="inv-actions">
      <button class="notes-icon-btn ${ct.notes ? 'has-notes' : 'empty'}" title="${ct.notes ? 'Edit note' : 'Add a note'}">📝</button>
      <button class="inv-del secondary" title="Remove this CT">✕</button>
    </td>
  `;
  $('input.inv-tape', tr).addEventListener('change', e => { ct.tapeLabel = e.target.value.trim(); markDirty(`tape "${ct.tapeLabel}" on ${ct.id}`); renderAll(); });
  $('input.inv-label', tr).addEventListener('change', e => { ct.label = e.target.value.trim(); markDirty(`label "${ct.label}" on ${ct.id}`); renderAll(); });
  $('select.inv-model', tr).addEventListener('change', e => { ct.model = e.target.value; markDirty(`model ${ct.model} on ${ct.id}`); renderAll(); });
  $('select.inv-port', tr).addEventListener('change', e => {
    const newPort = e.target.value ? parseInt(e.target.value) : null;
    ct.port = newPort;
    markDirty(`port → ${newPort ?? 'none'} on ${ct.id}`);
    renderAll();
  });
  $('.notes-icon-btn', tr).addEventListener('click', () => openCtNotesModal(ct));
  $('button.inv-del', tr).addEventListener('click', () => {
    if (!confirm(`Remove CT "${ct.label || ct.id}"? It will be unassigned from any breaker.`)) return;
    panel.cts = panel.cts.filter(c => c.id !== ct.id);
    for (const side of ['left', 'right']) {
      for (const b of panel[side]) if (b.ctId === ct.id) b.ctId = null;
    }
    markDirty(`removed CT ${ct.id}`);
    renderAll();
  });
  return tr;
}

function addCt() {
  let i = panel.cts.length + 1;
  while (panel.cts.some(c => c.id === `ct-${i}`)) i++;
  const id = `ct-${i}`;
  panel.cts.push({ id, label: `CT ${i}`, tapeLabel: "", model: "SCT-013-030", port: null, notes: "" });
  markDirty(`added new CT ${id}`);
  renderAll();
  setTimeout(() => {
    const tr = $(`tr[data-ct-id="${id}"]`);
    if (tr) tr.querySelector('input.inv-tape').focus();
  }, 0);
}

function renderMains() {
  const container = $('#mains-cts');
  container.innerHTML = '';
  for (const port of [1, 2]) {
    const ct = getCtByPort(port);
    if (ct) {
      container.insertAdjacentHTML('beforeend', compactCtCard(ct));
    } else {
      const p = getPortData(port);
      container.insertAdjacentHTML('beforeend', `
        <div class="compact-ct empty-port">
          <div class="compact-ct-row1">
            <span class="bk-ct-tape muted-badge">port ${port}</span>
            <span class="compact-ct-name muted-badge">no CT in inventory</span>
          </div>
          <div class="compact-ct-row2">
            <span class="live zero">${p ? fmt(p.amps, 2) + ' A' : '—'}</span>
            <span class="live zero">${p ? fmt(p.watts, 0) + ' W' : '—'}</span>
          </div>
        </div>
      `);
    }
  }
  hookCalButtons(container);

  // Single combined unaccounted gap, shown in the Main Service header
  const sideSums = computeSideBranchSums();
  const p1 = getPortData(1), p2 = getPortData(2);
  const mainsA = (parseFloat(p1?.amps || 0) + parseFloat(p2?.amps || 0)) || 0;
  const mainsW = (parseFloat(p1?.watts || 0) + parseFloat(p2?.watts || 0)) || 0;
  const branchA = sideSums.left.amps + sideSums.right.amps;
  const branchW = sideSums.left.watts + sideSums.right.watts;
  const gapA = mainsA - branchA;
  const gapW = mainsW - branchW;
  const gapPct = mainsW > 0 ? (100 * gapW / mainsW) : 0;
  const pill = $('#mains-gap');
  if (pill) {
    pill.textContent = `Total unaccounted: ${gapA.toFixed(2)} A · ${gapW.toFixed(0)} W (${gapPct.toFixed(0)}%)`;
    pill.classList.toggle('gap-big', Math.abs(gapW) > 100);
  }
}

function computeSideBranchSums() {
  // For 240V loads (port 6 dryer, port 11 HWH), the branch CT reads single-leg amps,
  // but mains counts that current TWICE (once on L1, once on L2). To make the gap
  // math comparable to mains, double the amps for is240 branches. Watts are already
  // correct on both sides (the multiply×−2 filter handles it for branch power).
  const out = { left: { amps: 0, watts: 0 }, right: { amps: 0, watts: 0 } };
  for (const side of ['left', 'right']) {
    for (const bk of panel[side]) {
      if (!bk.ctId) continue;
      const ct = getCt(bk.ctId);
      if (!ct || !ct.port) continue;
      if (MAINS_PORTS.has(ct.port)) continue; // mains aren't branches
      const p = getPortData(ct.port);
      if (!p) continue;
      const a = parseFloat(p.amps);
      const w = parseFloat(p.watts);
      const ampsCounted = (isFinite(a) ? a : 0) * (p.is240 ? 2 : 1);
      out[side].amps += ampsCounted;
      if (isFinite(w)) out[side].watts += w;
    }
  }
  return out;
}

function renderBreakers() {
  const grid = $('#panel-grid');
  // Wipe everything except the column headers
  grid.querySelectorAll('.breaker').forEach(n => n.remove());
  grid.querySelectorAll('.edit-row-host').forEach(n => n.remove());


  for (const side of ['left', 'right']) {
    const colIdx = side === 'left' ? 1 : 2;
    const breakers = panel[side];
    for (let idx = 0; idx < breakers.length; idx++) {
      const breakerIdx = idx;
      const bk = breakers[idx];
      const next = breakers[idx + 1];
      const isPair = bk.tiedToNext && next;
      const ct = bk.ctId ? getCt(bk.ctId) : null;

      const div = document.createElement('div');
      div.className = 'breaker';
      if (isPair) div.classList.add('breaker-pair', 'tied');
      if (!bk.wireLabel && !bk.houseLabel) div.classList.add('empty');
      if (bk.gfci) div.classList.add('gfci');
      if (ct) div.classList.add('has-ct');
      div.dataset.side = side;
      div.dataset.idx = breakerIdx;

      // Place explicitly in grid: row = pos + 1 (row 1 is for headers)
      div.style.gridColumn = colIdx;
      div.style.gridRow = `${bk.pos + 1} / span ${isPair ? 2 : 1}`;

      const posLabel = isPair ? `${bk.pos} / ${next.pos}` : `${bk.pos}`;
      const tagLine = isPair ? '<span class="bk-amp-tag">240V</span>' : '';

      div.innerHTML = `
        <div class="bk-pos">${posLabel}</div>
        <div class="bk-content">
          <div class="bk-field bk-field-wire">
            <span class="bk-field-label">Wire</span>
            <span class="bk-field-value ${bk.wireLabel ? '' : 'empty-text'}">${escapeHtml(bk.wireLabel) || '<empty>'}</span>
            ${bk.gfci ? '<span class="badge gfci-badge">GFCI</span>' : ''}
          </div>
          ${bk.houseLabel ? `
          <div class="bk-field bk-field-house">
            <span class="bk-field-label">House</span>
            <span class="bk-field-value">${escapeHtml(bk.houseLabel)}</span>
          </div>` : ''}
          ${bk.notes ? `
          <div class="bk-field bk-field-notes" title="${escapeHtml(bk.notes)}">
            <span class="bk-field-label">Notes</span>
            <span class="bk-field-value">${escapeHtml(bk.notes)}</span>
          </div>` : ''}
          ${ct ? compactCtRow(ct) : ''}
        </div>
        <div class="bk-amp">
          <span class="bk-amp-num">${bk.amperage}A</span>
          ${tagLine}
        </div>
      `;
      div.addEventListener('click', e => {
        const calBtn = e.target.closest('.btn-cal');
        if (calBtn) {
          e.stopPropagation();
          const cId = calBtn.dataset.ctId;
          const c = getCt(cId);
          if (c) openCal(c);
          return;
        }
        if (e.target.closest('.bk-ct-line') && !e.target.closest('.btn-cal')) return;
        editBreaker(side, breakerIdx);
      });
      grid.appendChild(div);
      if (isPair) idx++;
    }
  }
}

function renderUnassigned() {
  const container = $('#unassigned-cts');
  container.innerHTML = '';
  let count = 0;
  for (const ct of panel.cts) {
    if (!ct.port) continue;
    if (MAINS_PORTS.has(ct.port)) continue;
    if (isCtAssignedToBreaker(ct.id)) continue;
    container.insertAdjacentHTML('beforeend', compactCtCard(ct));
    count++;
  }
  if (count === 0) {
    container.innerHTML = '<p class="muted">All plugged-in CTs are mapped to a breaker (or to mains).</p>';
  }
  hookCalButtons(container);
}

function hookCalButtons(scope) {
  $$('.btn-cal', scope).forEach(b => {
    b.addEventListener('click', () => {
      const cId = b.dataset.ctId;
      const c = getCt(cId);
      if (c) openCal(c);
    });
  });
}

let activeBreakerEdit = null;

function editBreaker(side, idx) {
  const bk = panel[side][idx];
  const next = panel[side][idx + 1];
  const isPair = bk.tiedToNext && next;
  activeBreakerEdit = { side, idx };

  const ctOptions = ['<option value="">— no CT —</option>'];
  for (const ct of panel.cts) {
    if (ct.port && MAINS_PORTS.has(ct.port)) continue;
    const occBreaker = getBreakerForCt(ct.id);
    const isHere = bk.ctId === ct.id;
    const occElsewhere = occBreaker && !isHere;
    const portTag = ct.port ? ` · port ${ct.port}` : ' · unplugged';
    const occTag = occElsewhere ? ` (used at ${occBreaker.side[0].toUpperCase()}${occBreaker.pos})` : '';
    const tapePart = ct.tapeLabel ? `[${ct.tapeLabel}] ` : '';
    ctOptions.push(
      `<option value="${ct.id}" ${isHere ? 'selected' : ''} ${occElsewhere ? 'disabled' : ''}>` +
      `${escapeHtml(tapePart + (ct.label || ct.id))}${portTag}${occTag}</option>`
    );
  }

  const slotLabel = `Slot ${side[0].toUpperCase()}${bk.pos}${isPair ? '–' + next.pos : ''}`;
  $('#bre-title').textContent = `Edit ${slotLabel}`;
  $('#bre-meta').textContent = slotLabel;
  $('#bre-body').innerHTML = `
    <div class="edit-row edit-row-stacked">
      <div class="edit-grid-top">
        <label class="ed-field"><span>My label (correct)</span>
          <input type="text" class="ed-label" placeholder="e.g. Washer outlet" value="${escapeHtml(bk.wireLabel || '')}">
        </label>
        <label class="ed-field"><span>House label (electrician's writing)</span>
          <input type="text" class="ed-house" placeholder="e.g. KITCHEN" value="${escapeHtml(bk.houseLabel || '')}">
        </label>
        <label class="ed-field"><span>Amps</span>
          <input type="number" class="ed-amp" value="${bk.amperage || 20}" min="5" max="200">
        </label>
        <label class="ed-field"><span>Assign CT</span>
          <select class="ed-ct">${ctOptions.join('')}</select>
        </label>
      </div>
      <div class="edit-grid-mid">
        <label class="ed-checks"><input type="checkbox" class="ed-tied" ${bk.tiedToNext ? 'checked' : ''}> 240V tied (occupies pos ${bk.pos + 1} too)</label>
        <label class="ed-checks"><input type="checkbox" class="ed-gfci" ${bk.gfci ? 'checked' : ''}> GFCI</label>
      </div>
      <label class="ed-field ed-notes-field"><span>Notes</span>
        <textarea class="ed-notes" rows="3" placeholder="Anything worth remembering about this slot…">${escapeHtml(bk.notes || '')}</textarea>
      </label>
    </div>
  `;
  $('#breaker-edit-dialog').showModal();
  setTimeout(() => {
    const lbl = $('#bre-body .ed-label');
    if (lbl) { lbl.focus(); lbl.select(); }
  }, 30);
}

function closeBreakerEdit(save) {
  const dialog = $('#breaker-edit-dialog');
  if (save && activeBreakerEdit) {
    const { side, idx } = activeBreakerEdit;
    const bk = panel[side][idx];
    const body = $('#bre-body');
    bk.wireLabel = $('.ed-label', body).value.trim();
    bk.houseLabel = $('.ed-house', body).value.trim();
    bk.amperage = parseInt($('.ed-amp', body).value) || 20;
    bk.tiedToNext = $('.ed-tied', body).checked;
    bk.gfci = $('.ed-gfci', body).checked;
    const newCt = $('.ed-ct', body).value || null;
    const ctChanged = bk.ctId !== newCt;
    bk.ctId = newCt;
    bk.notes = $('.ed-notes', body).value.trim();
    markDirty(`updated ${side[0].toUpperCase()}${bk.pos}` + (ctChanged ? ` (CT ${newCt || 'cleared'})` : ''));
    renderAll();
  }
  dialog.close();
  activeBreakerEdit = null;
}

// === Auto-save (G1) =========================================================
function markDirty(reason) {
  $('#save-status').textContent = '⏳ saving…';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => doSave(reason), 500);
}

async function doSave(reason) {
  try {
    await api("POST", "/api/panel", panel);
    $('#save-status').textContent = `✓ saved ${new Date().toLocaleTimeString()}`;
    if (reason) api("POST", "/api/log", { msg: reason }).catch(() => {});
  } catch (e) {
    $('#save-status').textContent = `⚠ save failed: ${e.message}`;
  }
}

async function takeSnapshot() {
  try {
    const r = await api("POST", "/api/snapshot");
    $('#save-status').textContent = `📸 snapshot ${r.file}`;
  } catch (e) {
    $('#save-status').textContent = `⚠ snapshot failed: ${e.message}`;
  }
}

async function exportYaml() {
  try {
    const text = await api("GET", "/api/yaml-export");
    $('#yaml-content').textContent = text;
    $('#yaml-dialog').showModal();
  } catch (e) {
    showError('Export failed: ' + e.message);
  }
}

async function copyYaml() {
  const text = $('#yaml-content').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('#yaml-copy').textContent = '✓ Copied';
    setTimeout(() => $('#yaml-copy').textContent = 'Copy to clipboard', 2000);
  } catch {
    $('#yaml-copy').textContent = '✗ Copy denied';
  }
}

// === Calibration ============================================================
function openCal(ct) {
  if (!ct.port) {
    showError(`CT "${ct.label}" isn't assigned to a port — set its port in the inventory before calibrating.`);
    return;
  }
  const p = getPortData(ct.port);
  if (!p) return showError('No live data for port ' + ct.port);
  activeCal = { ct, port: p };
  $('#cal-section').hidden = false;
  $('#cal-channel-name').textContent = `${ct.label || ct.id} (port ${ct.port})`;
  $('#cal-chip').textContent = `${p.chip} (V${p.vsuf})`;
  $('#cal-live-v').textContent = fmt(liveState?.voltage1, 2);
  $('#cal-raw').textContent = `${fmt(p.amps, 4)} A / ${fmt(p.watts, 2)} W`;
  $('#cal-ref-v').value = liveState?.voltage1 ? parseFloat(liveState.voltage1).toFixed(2) : '';
  // F1: prefill Ref Current with the chip's current reading
  $('#cal-ref-i').value = isFinite(parseFloat(p.amps)) ? parseFloat(p.amps).toFixed(2) : '';
  $('#cal-log').textContent = '';
  $$('#cal-section button[data-action]').forEach(b => {
    b.onclick = () => calAction(b.dataset.action);
  });
  calLog(`Opened cal for ${ct.label || ct.id} (port ${ct.port}, slug=${p.slug}, chip ${p.chip})`);
  $('#cal-section').scrollIntoView({behavior:'smooth', block:'start'});
}

function calLog(msg) {
  const ts = new Date().toLocaleTimeString();
  const log = $('#cal-log');
  log.textContent += `[${ts}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
}

async function calAction(action) {
  const ac = activeCal;
  if (!ac) return;
  const { ct, port: p } = ac;
  try {
    if (action === 'set-ref-v') {
      const v = parseFloat($('#cal-ref-v').value);
      if (isNaN(v)) return calLog('ERROR: enter a number for Ref V');
      await api("POST", "/api/cal/set-ref-v", { chip: p.chip, vsuf: p.vsuf, value: v });
      calLog(`✓ Ref V set to ${v} (${p.chip} V${p.vsuf})`);
    } else if (action === 'use-live-v') {
      const v = parseFloat(liveState?.voltage1);
      if (isNaN(v)) return calLog('ERROR: no live voltage');
      $('#cal-ref-v').value = v.toFixed(2);
      await api("POST", "/api/cal/set-ref-v", { chip: p.chip, vsuf: p.vsuf, value: v });
      calLog(`✓ Ref V set to live V1 = ${v.toFixed(2)}`);
    } else if (action === 'use-live-i') {
      const live = getPortData(ct.port);
      const v = parseFloat(live?.amps);
      if (isNaN(v)) return calLog('ERROR: no raw chip reading');
      $('#cal-ref-i').value = v.toFixed(4);
      calLog(`Filled Ref I with raw chip reading ${v.toFixed(4)} A — adjust to clamp meter then press Set`);
    } else if (action === 'set-ref-i') {
      const v = parseFloat($('#cal-ref-i').value);
      if (isNaN(v)) return calLog('ERROR: enter a number for Ref I');
      await api("POST", "/api/cal/set-ref-current", { slug: p.slug, value: v });
      calLog(`✓ Ref I set to ${v} A on ${p.slug}`);
    } else if (action === 'clear-all') {
      for (const a of ['gain_clear', 'power_offset_clear', 'offset_clear']) {
        await api("POST", "/api/cal/press", { action: a, chip: p.chip });
        calLog(`✓ Pressed ${a} on ${p.chip}`);
      }
    } else if (action === 'run-offset') {
      await api("POST", "/api/cal/press", { action: 'offset_run', chip: p.chip });
      calLog(`✓ Pressed: 1. Offset Cal on ${p.chip}`);
    } else if (action === 'run-power-offset') {
      await api("POST", "/api/cal/press", { action: 'power_offset_run', chip: p.chip });
      calLog(`✓ Pressed: 2. Power Offset Cal on ${p.chip}`);
    } else if (action === 'run-gain') {
      await api("POST", "/api/cal/press", { action: 'gain_run', chip: p.chip });
      calLog(`✓ Pressed: 3. Gain Cal on ${p.chip}`);
    } else if (action === 'run-full') {
      // F3: full sequence with prompts
      if (!confirm(`This will run Clear → Offset → Power Offset → Gain on chip ${p.chip}.\n\nFor offset steps, ALL CTs on that chip must be at NO LOAD.\nThen for gain, ${ct.label || ct.id} needs a steady reference current matching what's in Ref I (${$('#cal-ref-i').value} A).\n\nProceed?`)) {
        calLog('Cancelled.');
        return;
      }
      const refV = parseFloat($('#cal-ref-v').value);
      const refI = parseFloat($('#cal-ref-i').value);
      if (isNaN(refV) || isNaN(refI)) {
        calLog('ERROR: Set both Ref V and Ref I before running full sequence.');
        return;
      }
      calLog('=== Full sequence start ===');
      for (const a of ['gain_clear', 'power_offset_clear', 'offset_clear']) {
        await api("POST", "/api/cal/press", { action: a, chip: p.chip });
        calLog(`✓ ${a}`);
      }
      await api("POST", "/api/cal/set-ref-v", { chip: p.chip, vsuf: p.vsuf, value: refV });
      calLog(`✓ Ref V = ${refV}`);
      if (!confirm(`Ready for OFFSET cal.\n\nMake sure ALL CTs on chip ${p.chip} have NO current flowing, then press OK.`)) {
        calLog('Aborted before offset.');
        return;
      }
      await api("POST", "/api/cal/press", { action: 'offset_run', chip: p.chip });
      calLog('✓ offset_run pressed; waiting 3s');
      await new Promise(r => setTimeout(r, 3000));
      await api("POST", "/api/cal/press", { action: 'power_offset_run', chip: p.chip });
      calLog('✓ power_offset_run pressed; waiting 3s');
      await new Promise(r => setTimeout(r, 3000));
      if (!confirm(`Ready for GAIN cal.\n\nTurn ON ${ct.label || ct.id}, wait until it's steady at ~${refI} A on your clamp meter, then press OK.`)) {
        calLog('Aborted before gain.');
        return;
      }
      await api("POST", "/api/cal/set-ref-current", { slug: p.slug, value: refI });
      calLog(`✓ Ref I = ${refI}`);
      await api("POST", "/api/cal/press", { action: 'gain_run', chip: p.chip });
      calLog('✓ gain_run pressed');
      calLog('=== Full sequence complete ===');
    }
    setTimeout(refresh, 1500);
  } catch (e) {
    calLog('ERROR: ' + e.message);
  }
}

// === Printable two-page wall-reference PDF =================================
function buildPrintView() {
  const ds = new Date().toLocaleDateString();
  const ts = $('#print-date-1'); if (ts) ts.textContent = ds;
  const ts2 = $('#print-date-2'); if (ts2) ts2.textContent = ds;
  buildPrintPanel();
  buildPrintBoard();
}

function buildPrintPanel() {
  const rowsHost = $('#print-panel-rows');
  rowsHost.innerHTML = '';

  // Build per-side cell arrays of length 30, indexed by physical slot (pos-1).
  // Tied pairs occupy two consecutive slots: top slot = full cell, bottom slot = "continuation" placeholder so the next row stays aligned across both sides.
  function sideCells(side) {
    const breakers = panel[side];
    const cells = new Array(breakers.length).fill(null);
    for (let i = 0; i < breakers.length; i++) {
      const bk = breakers[i];
      const next = breakers[i + 1];
      const isPair = bk.tiedToNext && next;
      cells[bk.pos - 1] = { bk, next: isPair ? next : null, isPair, isContinuation: false };
      if (isPair) {
        cells[next.pos - 1] = { bk, next, isPair: true, isContinuation: true };
        i++;
      }
    }
    return cells;
  }

  function renderCell(cell) {
    if (!cell) return '<div class="print-breaker print-empty"><div class="print-breaker-pos">—</div><div class="print-breaker-body"></div></div>';
    if (cell.isContinuation) {
      return `<div class="print-breaker print-breaker-cont"><div class="print-breaker-pos">${cell.next.pos}<span class="print-amp">${cell.next.amperage}A</span></div><div class="print-breaker-body"><div class="print-cont-label">↑ tied to ${cell.bk.pos}</div></div></div>`;
    }
    const { bk, next, isPair } = cell;
    const ct = bk.ctId ? getCt(bk.ctId) : null;
    const classes = ['print-breaker'];
    if (isPair) classes.push('print-breaker-pair');
    if (!bk.wireLabel && !bk.houseLabel) classes.push('print-empty');
    if (bk.gfci) classes.push('print-gfci');
    const posLabel = isPair ? `${bk.pos} / ${next.pos}` : `${bk.pos}`;
    const tags = [];
    if (isPair) tags.push('<span class="print-tag print-tag-tied">240V</span>');
    if (bk.gfci) tags.push('<span class="print-tag print-tag-gfci">GFCI</span>');
    if (ct) tags.push('<span class="print-tag print-tag-ct">CT</span>');
    const metaParts = [];
    if (bk.houseLabel) metaParts.push(`<em>${escapeHtml(bk.houseLabel)}</em>`);
    if (ct) metaParts.push(`CT${ct.tapeLabel ? ' ['+escapeHtml(ct.tapeLabel)+']' : ''} ${escapeHtml(ct.label || ct.id)} → port ${ct.port}`);
    if (bk.notes) metaParts.push(escapeHtml(bk.notes));
    return `
      <div class="${classes.join(' ')}">
        <div class="print-breaker-pos">${posLabel}<span class="print-amp">${bk.amperage}A</span></div>
        <div class="print-breaker-body">
          <div class="print-line-1">
            <span class="print-wire">${escapeHtml(bk.wireLabel) || '<em>(empty)</em>'}</span>
            ${tags.length ? `<span class="print-tags">${tags.join('')}</span>` : ''}
          </div>
          ${metaParts.length ? `<div class="print-line-2">${metaParts.join(' · ')}</div>` : ''}
        </div>
      </div>`;
  }

  const left = sideCells('left');
  const right = sideCells('right');
  const rowCount = Math.max(left.length, right.length);
  for (let i = 0; i < rowCount; i++) {
    const row = document.createElement('div');
    row.className = 'print-panel-row';
    row.innerHTML = renderCell(left[i]) + renderCell(right[i]);
    rowsHost.appendChild(row);
  }
}

function buildPrintBoard() {
  // Layout, as you face the box (matches the wall-tape labels in IMG_1260):
  //   [ 7 ][ 1 ]  ┌─────────┐  [ 6 ][ 12 ]
  //   [ 8 ][ 2 ]  │  stack  │  [ 5 ][ 11 ]
  //   [ 9 ][ 3 ]  │ diagram │  [ 4 ][ 10 ]
  //               └─────────┘
  // Outer columns = top (add-on) board; inner columns = bottom (main) board.
  renderBoardColumn('#print-board-col-789', [7, 8, 9]);
  renderBoardColumn('#print-board-col-123', [1, 2, 3]);
  renderBoardColumn('#print-board-col-654', [6, 5, 4]);
  renderBoardColumn('#print-board-col-12_11_10', [12, 11, 10]);
}

function renderBoardColumn(selector, ports) {
  const col = $(selector);
  col.querySelectorAll('.print-board-cell').forEach(n => n.remove());
  for (const port of ports) col.appendChild(buildBoardCell(port));
}

function buildBoardCell(port) {
  const ct = getCtByPort(port);
  const breaker = ct ? getBreakerForCt(ct.id) : null;
  const breakerStr = breaker
    ? `${breaker.side[0].toUpperCase()}${breaker.pos}`
    : (port === 1 || port === 2 ? 'MAINS' : '—');

  const div = document.createElement('div');
  div.className = 'print-board-cell';
  if (!ct) div.classList.add('print-board-unassigned');
  div.innerHTML = `
    <div class="print-board-port">CT${port}</div>
    <div class="print-board-body">
      ${ct ? `
        <div class="print-board-tape">${ct.tapeLabel ? '['+escapeHtml(ct.tapeLabel)+']' : '<span class="muted">no tape</span>'}</div>
        <div class="print-board-label">${escapeHtml(ct.label || ct.id)}</div>
        <div class="print-board-meta">${escapeHtml(ct.model || '?')} · breaker <strong>${breakerStr}</strong></div>
        ${ct.notes ? `<div class="print-board-notes">${escapeHtml(ct.notes.length > 200 ? ct.notes.slice(0, 200) + '…' : ct.notes)}</div>` : ''}
      ` : `<div class="print-board-empty"><em>no CT in inventory</em></div>`}
    </div>
  `;
  return div;
}

init();
