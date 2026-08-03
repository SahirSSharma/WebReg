/* WebReg Revival — classic WebReg 2.0 single-page app.
   Consumes the pinned JSON API (see project docs). No frameworks.

   ACCESSIBILITY PASS (CSE134B): this file renders almost the entire UI
   from JS template strings, so most of the app's actual accessibility
   problems live here, not in index.html. Every change is commented
   in place with the WCAG 2.2 success criterion it's fixing. The
   running theme: a lot of "buttons" in the original were <span>/<div>
   elements with only a click handler — which means they render, they
   look right, and a mouse user never notices anything's wrong, but a
   keyboard-only or screen-reader user can't reach them at all (no
   native focusability, no announced role). That's WCAG 2.1.1 Keyboard
   and 4.1.2 Name, Role, Value, and it's the single biggest category
   of fix below. */
"use strict";

/* ================================================================ utils */

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/*
  WCAG 4.1.3 Status Messages (AA). One shared live region (#a11y-status,
  declared in index.html with aria-live="polite") that every "something
  just happened" moment in the app writes a short sentence into: search
  result counts changing, a class getting planned, an error coming back
  from the API. None of that used to be announced at all — a sighted
  user sees the results grid repaint or a green success modal pop up;
  a screen-reader user got total silence unless they went looking.
  Clearing the region first and re-setting it on a tiny delay is a
  common trick to make sure repeated identical messages ("1 course
  found" twice in a row) still get announced, since some AT only
  reacts to a live region's content actually changing.
*/
function announce(msg) {
  const el = $("#a11y-status");
  if (!el) return;
  el.textContent = "";
  window.setTimeout(() => { el.textContent = msg; }, 50);
}

/*
  Minimal focus trap for the modal dialog (WCAG 2.1.2 No Keyboard Trap —
  yes, the SC is *named* "no keyboard trap," but what it actually
  requires is that if focus enters a construct like a modal, the user
  can still move freely *within* it and get back out; a dialog that
  lets Tab silently walk focus into the page behind it is arguably a
  worse experience even though it's not technically "trapped" anywhere.
  See openModal()/closeModal() below for how this gets wired up and
  torn down.) Keeps Tab/Shift+Tab cycling among the dialog's own
  focusable elements instead of escaping into the page behind it.
*/
function trapFocus(container, evt) {
  const focusables = $all(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    container
  ).filter(el => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (evt.shiftKey && document.activeElement === first) {
    evt.preventDefault(); last.focus();
  } else if (!evt.shiftKey && document.activeElement === last) {
    evt.preventDefault(); first.focus();
  }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  let body = null;
  try { body = await r.json(); } catch (e) { /* non-json */ }
  if (!r.ok) {
    const err = new Error((body && body.error) || ("Request failed (" + r.status + ")"));
    err.status = r.status;
    throw err;
  }
  return body;
}

function post(path, data) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/* "9:30a" -> minutes from midnight; null if TBA/unparseable */
function parseTimeMin(t) {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])m?$/i.exec(String(t || "").trim());
  if (!m) return null;
  let h = (+m[1]) % 12;
  if (m[3].toLowerCase() === "p") h += 12;
  return h * 60 + (+m[2]);
}

/* "MTuWThF" / "TuTh" / "SA 12/12/2026" -> ["M","Tu",...] */
const DAY_TOKENS = ["Su", "Sa", "Th", "Tu", "M", "W", "F"];
function parseDays(d) {
  const s = String(d || "").trim();
  const out = [];
  let i = 0;
  while (i < s.length) {
    let hit = false;
    for (const t of DAY_TOKENS) {
      if (s.substr(i, t.length).toLowerCase() === t.toLowerCase()) {
        out.push(t); i += t.length; hit = true; break;
      }
    }
    if (!hit) i++;
  }
  return out;
}

function finalDate(daysField) {
  const m = /(\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(String(daysField || ""));
  return m ? m[1] : "";
}
function finalWeekday(daysField) {
  const toks = parseDays(String(daysField || "").replace(/\d.*$/, ""));
  if (toks.length) return toks[0];
  /* TSS (FA26) final rows carry a bare date with no weekday prefix — derive it */
  const d = finalDate(daysField);
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt) ? "" : ["Su", "M", "Tu", "W", "Th", "F", "Sa"][dt.getDay()];
}

function timeRange(s) {
  return (s.time_start && s.time_end) ? s.time_start + "-" + s.time_end : "TBA";
}

/* TSS uses 999/9998/9999 as a "no seat cap" sentinel (independent study,
   research, etc.); real caps top out well below that. Show these as TBA. */
const SEAT_SENTINEL = 999;
function isSentinelSeats(v) { return v != null && v >= SEAT_SENTINEL; }
function seatsDisplay(v) {
  return v == null ? "" : (v >= SEAT_SENTINEL ? "TBA" : String(v));
}
function orTBA(v) { return v ? esc(v) : "TBA"; }

function fmtUnitsVal(v) { return (+v).toFixed(2); }

/* units display text ("4", "2.5", "1-4", "2/4 by 2") -> array of numeric options */
function unitOptions(unitsText) {
  const u = String(unitsText == null ? "" : unitsText).trim();
  let m;
  if ((m = /^([\d.]+)\s*[-–]\s*([\d.]+)(?:\s*by\s*([\d.]+))?$/i.exec(u))) {
    const lo = +m[1], hi = +m[2], st = +(m[3] || 1) || 1;
    const out = [];
    for (let v = lo; v <= hi + 1e-9; v += st) out.push(+v.toFixed(2));
    return out.length ? out : [lo];
  }
  if ((m = /^([\d.]+)\s*\/\s*([\d.]+)(?:\s*by\s*([\d.]+))?$/i.exec(u))) {
    const lo = +m[1], hi = +m[2], st = +(m[3] || 0);
    if (st) {
      const out = [];
      for (let v = lo; v <= hi + 1e-9; v += st) out.push(+v.toFixed(2));
      return out;
    }
    return [+m[1], +m[2]];
  }
  const v = parseFloat(u);
  return isNaN(v) ? [4] : [v];
}

function unitsSuffix(unitsText) {
  const opts = unitOptions(unitsText);
  if (opts.length > 1) {
    const lo = opts[0], hi = opts[opts.length - 1];
    return "(" + (+lo) + "-" + (+hi) + " units)";
  }
  const v = opts[0];
  return "(" + (+v) + " unit" + (v === 1 ? "" : "s") + ")";
}

const GRADE_NAME = { L: "Letter", P: "Pass/No Pass", S: "Satisfactory/Unsatisfactory" };
const GRADE_CODE = { L: "L", P: "P/NP", S: "S/U" };
const TYPE_LONG = {
  LE: "Lecture", DI: "Discussion", LA: "Laboratory", SE: "Seminar", ST: "Studio",
  TU: "Tutorial", PR: "Practicum", IN: "Independent Study", FW: "Fieldwork",
  FI: "Final Exam", MI: "Midterm", RE: "Review", PB: "Problem Session",
};

/* ================================================================ state */

const S = {
  terms: [], subjects: [],
  term: null,
  courses: null,        // last raw search results
  lastSearch: null,     // query-string params (minus term) to re-run
  clientFilters: null,  // {days:[], start,end, ranges:[]}
  page: 1, pageSize: 10,
  open: new Set(),      // open drawer course ids
  resultsShown: true,
  panelCollapsed: false,
  schedule: [],
  view: "list",
  selSubjects: [],      // advanced-search subject codes
};

/* ================================================================ boot */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const [terms, subjects] = await Promise.all([api("/api/terms"), api("/api/subjects")]);
  S.terms = terms; S.subjects = subjects;

  const land = $("#landing-term"), sw = $("#term-switch");
  // Planning is for the upcoming term only — show just Fall 2026.
  const shown = terms.filter(t => t.code === "FA26");
  for (const t of (shown.length ? shown : terms)) {
    land.add(new Option(t.name, t.code, false, true));
    sw.add(new Option(t.name, t.code, false, true));
  }
  $("#btn-go").addEventListener("click", () => enterTerm(land.value));
  land.addEventListener("keydown", e => { if (e.key === "Enter") enterTerm(land.value); });
  sw.addEventListener("change", () => switchTerm(sw.value));

  buildTimeSelects();
  wireSearch();
  wireScheduleChrome();
  wireTipJar();
}

function wireTipJar() {
  const jar = $("#tip-jar"), bar = $("#tip-bar");
  if (!jar || !bar) return;
  // On phones the expanded jar overlaps the schedule/results — start it
  // collapsed by default there (unless the user has set a preference).
  const pref = localStorage.getItem("webreg_tip_collapsed");
  const collapse = pref === "1" || (pref === null && window.matchMedia("(max-width: 640px)").matches);
  if (collapse) jar.classList.add("collapsed");
  bar.addEventListener("click", () => {
    jar.classList.toggle("collapsed");
    localStorage.setItem("webreg_tip_collapsed",
      jar.classList.contains("collapsed") ? "1" : "0");
  });
}

function buildTimeSelects() {
  const opts = ["none"];
  for (let h = 7; h <= 21; h++) {
    const ap = h < 12 ? "a" : "p";
    const hh = ((h + 11) % 12) + 1;
    opts.push(hh + ":00" + ap);
  }
  for (const id of ["f-start", "f-end"]) {
    const sel = $("#" + id);
    for (const o of opts) sel.add(new Option(o, o));
  }
}

function enterTerm(code) {
  S.term = code;
  $("#screen-term").hidden = true;
  $("#screen-main").hidden = false;
  $("#term-switch").value = code;
  refreshSchedule();
  refreshScheduleList();
}

/* ---------------- named-schedule manager (My schedule: dropdown) */

async function refreshScheduleList() {
  let data;
  try { data = await api("/api/schedules"); }
  catch (e) { return; }   // older/Flask backend without multi-schedule support
  const sel = $("#sched-name");
  if (!sel) return;
  sel.innerHTML = "";
  const mine = document.createElement("optgroup");
  mine.label = "My schedules";
  for (const n of data.names) mine.appendChild(new Option(n, "s:" + n, false, n === data.active));
  sel.appendChild(mine);
  const acts = document.createElement("optgroup");
  acts.label = "———";
  acts.appendChild(new Option("＋  New schedule…", "__new"));
  acts.appendChild(new Option("⧉  Duplicate this one…", "__copy"));
  acts.appendChild(new Option("✎  Rename this one…", "__rename"));
  if (data.names.length > 1) acts.appendChild(new Option("🗑  Delete this one", "__delete"));
  sel.appendChild(acts);
  sel.dataset.active = data.active;
}

async function onSchedNameChange() {
  const sel = $("#sched-name");
  const v = sel.value;
  const active = sel.dataset.active || "";
  try {
    if (v.startsWith("s:")) {
      if (v.slice(2) !== active) await post("/api/schedules/activate", { name: v.slice(2) });
    } else if (v === "__new") {
      const n = (prompt("Name your new schedule:", "Plan B") || "").trim();
      if (!n) return refreshScheduleList();
      await post("/api/schedules/create", { name: n });
    } else if (v === "__copy") {
      const n = (prompt("Name for the copy:", active + " copy") || "").trim();
      if (!n) return refreshScheduleList();
      const r = await post("/api/schedules/copy", { name: n });
      migrateEvents(active, (r && r.active) || n, true);
    } else if (v === "__rename") {
      const n = (prompt("Rename “" + active + "” to:", active) || "").trim();
      if (!n) return refreshScheduleList();
      const r = await post("/api/schedules/rename", { name: n });
      const now = (r && r.active) || n;
      if (now !== active) migrateEvents(active, now, false);
    } else if (v === "__delete") {
      if (!confirm("Delete the schedule “" + active + "”? This can’t be undone.")) return refreshScheduleList();
      await post("/api/schedules/delete", {});
      deleteEventsFor(active);
    }
  } catch (e) {
    alert(e.message || "Couldn’t update schedules.");
  }
  await refreshSchedule();
  await refreshScheduleList();
}

function switchTerm(code) {
  S.term = code;
  S.courses = null;
  $("#results-region").hidden = true;
  refreshSchedule();
  if (S.lastSearch) runSearch(S.lastSearch, S.clientFilters);
}

/* ================================================================ search UI */

function wireSearch() {
  $("#btn-search").addEventListener("click", simpleSearch);
  $("#q").addEventListener("keydown", e => {
    const acOpen = !$("#ac").hidden;
    if (e.key === "ArrowDown" && acOpen) { e.preventDefault(); acSetActive(acActiveIdx + 1); }
    else if (e.key === "ArrowUp" && acOpen) { e.preventDefault(); acSetActive(acActiveIdx - 1); }
    else if (e.key === "Enter") {
      const items = $all("#ac div");
      if (acOpen && acActiveIdx >= 0 && items[acActiveIdx]) {
        /* a suggestion is highlighted via the keyboard — Enter picks it,
           same as a mouse click would (WCAG 2.1.1 Keyboard: every
           mouse-operable action needs a keyboard equivalent) */
        e.preventDefault();
        $("#q").value = items[acActiveIdx].dataset.code;
        hideAc();
        simpleSearch();
      } else {
        hideAc();
        simpleSearch();
      }
    } else if (e.key === "Escape" && acOpen) { hideAc(); }
  });
  $("#q").addEventListener("input", updateAc);
  $("#q").addEventListener("blur", () => setTimeout(hideAc, 180));

  /* aria-expanded is the mechanism (not the button's own text) that
     tells a screen reader whether the thing it controls is open — WCAG
     4.1.2 Name, Role, Value. These three toggles already changed their
     visible label on click, but were never updating aria-expanded to
     match, so AT and sighted users could disagree about the state. */
  $("#lnk-adv").addEventListener("click", () => {
    const adv = $("#adv");
    adv.hidden = !adv.hidden;
    $("#lnk-adv").textContent = adv.hidden ? "Advanced Search" : "Hide advanced search";
    $("#lnk-adv").setAttribute("aria-expanded", String(!adv.hidden));
  });
  $("#btn-search2").addEventListener("click", advSearch);
  $("#btn-reset").addEventListener("click", resetAdv);

  $("#page-size").addEventListener("change", () => {
    S.pageSize = +$("#page-size").value; S.page = 1; renderResults();
  });
  $("#lnk-toggle-results").addEventListener("click", () => {
    S.resultsShown = !S.resultsShown;
    $("#results-inner").hidden = !S.resultsShown;
    $("#lnk-toggle-results").textContent = S.resultsShown ? "Hide search result" : "Show search result";
    $("#lnk-toggle-results").setAttribute("aria-expanded", String(S.resultsShown));
  });
  $("#panel-collapse").addEventListener("click", () => {
    S.panelCollapsed = !S.panelCollapsed;
    $("#results-body").hidden = S.panelCollapsed;
    $("#panel-collapse").innerHTML = S.panelCollapsed ? "+" : "&#8211;";
    $("#panel-collapse").setAttribute("aria-expanded", String(!S.panelCollapsed));
    $("#panel-collapse").setAttribute("aria-label", S.panelCollapsed ? "Expand search results" : "Collapse search results");
  });

  wireSubjectTokens();
}

/* subject typeahead on the simple box */
/*
  #q was already a text input, so it was always keyboard-typeable — the
  gap was that the suggestion list popping up underneath it had zero
  ARIA relationship to the input (WCAG 4.1.2 Name, Role, Value) and no
  way to arrow through it (WCAG 2.1.1 Keyboard); a sighted mouse user
  could see and click a suggestion, but a screen-reader user had no
  idea the list existed. #q already carries role="combobox" +
  aria-controls="ac" from index.html; this adds the other half of the
  WAI-ARIA combobox pattern: role="option" on each suggestion,
  aria-activedescendant tracking which one is highlighted, and
  Up/Down/Enter handling. AC_ACTIVE_IDX/module state kept local to this
  file (not on S) since it's pure UI transient state.
*/
let acActiveIdx = -1;

function updateAc() {
  const q = $("#q").value.trim();
  const box = $("#ac");
  const input = $("#q");
  if (q.length < 2 || /\s/.test(q)) { hideAc(); return; }
  const ql = q.toLowerCase();
  const hits = S.subjects.filter(s =>
    s.code.toLowerCase().startsWith(ql) || s.name.toLowerCase().includes(ql)).slice(0, 12);
  if (!hits.length) { hideAc(); return; }
  box.innerHTML = hits.map((s, i) => {
    const label = s.code + " / " + s.name;
    const idx = label.toLowerCase().indexOf(ql);
    const html = idx < 0 ? esc(label)
      : esc(label.slice(0, idx)) + "<u>" + esc(label.slice(idx, idx + q.length)) + "</u>" + esc(label.slice(idx + q.length));
    return '<div id="ac-opt-' + i + '" role="option" aria-selected="false" data-code="' + esc(s.code) + '">' + html + "</div>";
  }).join("");
  box.hidden = false;
  input.setAttribute("aria-expanded", "true");
  acActiveIdx = -1;
  $all("div", box).forEach(d => d.addEventListener("mousedown", () => {
    $("#q").value = d.dataset.code;
    hideAc();
    simpleSearch();
  }));
}

function acSetActive(i) {
  const items = $all("#ac div");
  if (!items.length) return;
  acActiveIdx = (i + items.length) % items.length;
  items.forEach((el, idx) => el.setAttribute("aria-selected", String(idx === acActiveIdx)));
  $("#q").setAttribute("aria-activedescendant", items[acActiveIdx].id);
}

function hideAc() {
  $("#ac").hidden = true;
  $("#q").setAttribute("aria-expanded", "false");
  $("#q").removeAttribute("aria-activedescendant");
  acActiveIdx = -1;
}

/* advanced-search subject chips */
/*
  The subject picker is a custom widget with no native HTML equivalent
  (a multi-select of "chips" that opens a filterable dropdown), so
  every bit of keyboard support has to be built by hand — WCAG 2.1.1
  Keyboard. Three separate fixes here:
    1. Each chip's "x" used to be a <span> inside a <span> that was
       only removable by clicking exactly on it with a mouse — no
       keyboard path existed at all. It's now a real <button> with a
       descriptive aria-label ("Remove CSE / Computer Science...")
       instead of a lone "×" glyph, which also fixes WCAG 4.1.2 (a
       button whose only accessible name is a multiplication sign
       tells a screen-reader user nothing about what it removes).
    2. The box itself (already given tabindex="0"/role="group" in
       index.html) opens the dropdown on Enter/Space, not just click.
    3. The floating filter dropdown gets role="listbox"/"option" and
       Up/Down/Enter/Escape handling, instead of being mousedown-only
       <div>s — the WAI-ARIA combobox-with-listbox pattern.
*/
function wireSubjectTokens() {
  const box = $("#subj-box");
  let drop = null;

  function renderChips() {
    box.innerHTML = "";
    if (!S.selSubjects.length) {
      box.innerHTML = '<span class="placeholder">Select one or more</span>';
      return;
    }
    for (const code of S.selSubjects) {
      const sub = S.subjects.find(s => s.code === code);
      const chip = document.createElement("span");
      chip.className = "tok";
      const label = code + " / " + (sub ? sub.name : "");
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "x";
      removeBtn.setAttribute("aria-label", "Remove " + label);
      removeBtn.textContent = "×";
      chip.appendChild(removeBtn);
      chip.appendChild(document.createTextNode(label));  /* createTextNode is already safe against injection — esc() is only needed when building innerHTML strings, not real text nodes */
      const remove = e => {
        e.stopPropagation();
        S.selSubjects = S.selSubjects.filter(c => c !== code);
        renderChips();
        box.focus();
      };
      removeBtn.addEventListener("click", remove);
      box.appendChild(chip);
    }
  }
  box.renderChips = renderChips;

  function openDrop() {
    closeDrop();
    drop = document.createElement("div");
    drop.className = "tokdrop";
    const r = box.getBoundingClientRect();
    drop.style.left = (r.left + window.scrollX) + "px";
    drop.style.top = (r.bottom + window.scrollY) + "px";
    drop.innerHTML = '<label class="visually-hidden" for="subj-filter">Filter subjects</label>'
      + '<input id="subj-filter" placeholder="Type to filter" role="combobox" aria-expanded="true" aria-controls="subj-listbox" aria-autocomplete="list">'
      + '<div class="opts" id="subj-listbox" role="listbox" aria-label="Matching subjects"></div>';
    document.body.appendChild(drop);
    const inp = $("input", drop);
    const opts = $(".opts", drop);
    let activeIdx = -1;

    function setActive(i) {
      const items = $all(".opt", opts);
      if (!items.length) { activeIdx = -1; return; }
      activeIdx = (i + items.length) % items.length;
      items.forEach((el, idx) => el.setAttribute("aria-selected", String(idx === activeIdx)));
      items[activeIdx].scrollIntoView({ block: "nearest" });
      inp.setAttribute("aria-activedescendant", items[activeIdx].id);
    }
    function choose(code) {
      S.selSubjects.push(code);
      renderChips();
      fill(inp.value);
      inp.focus();
    }
    function fill(f) {
      const fl = (f || "").toLowerCase();
      const matches = S.subjects
        .filter(s => !S.selSubjects.includes(s.code))
        .filter(s => !fl || s.code.toLowerCase().startsWith(fl) || s.name.toLowerCase().includes(fl))
        .slice(0, 400);
      opts.innerHTML = matches
        .map((s, i) => '<div class="opt" role="option" id="subj-opt-' + i + '" data-code="' + esc(s.code) + '">'
          + esc(s.code + " / " + s.name) + "</div>")
        .join("");
      activeIdx = -1;
      $all(".opt", opts).forEach(d => d.addEventListener("mousedown", e => {
        e.preventDefault();
        choose(d.dataset.code);
      }));
    }
    inp.addEventListener("keydown", e => {
      const items = $all(".opt", opts);
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) choose(items[activeIdx].dataset.code);
      } else if (e.key === "Escape") { e.preventDefault(); closeDrop(); box.focus(); }
    });
    fill("");
    inp.addEventListener("input", () => fill(inp.value));
    inp.focus();
  }
  function closeDrop() { if (drop) { drop.remove(); drop = null; } }

  box.addEventListener("click", openDrop);
  box.addEventListener("keydown", e => {
    if (e.target !== box) return;   /* don't fire when focus is on a chip's remove button */
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrop(); }
  });
  document.addEventListener("mousedown", e => {
    if (drop && !drop.contains(e.target) && !box.contains(e.target)) closeDrop();
  });
}

function resetAdv() {
  S.selSubjects = [];
  $("#subj-box").renderChips();
  for (const id of ["f-courseno", "f-instructor", "f-title", "f-sectionid"]) $("#" + id).value = "";
  $all(".rng").forEach(c => { c.checked = false; });
  $all(".day").forEach(c => { c.checked = false; });
  $("#f-start").value = "none";
  $("#f-end").value = "none";
  $("#f-open").checked = false;
}

function simpleSearch() {
  hideAc();
  const q = $("#q").value.trim();
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  runSearch(params.toString(), null);
}

function advSearch() {
  const params = new URLSearchParams();
  if (S.selSubjects.length) params.set("subjects", S.selSubjects.join(","));
  const nums = $("#f-courseno").value.trim().split(/[,\s]+/).filter(Boolean);
  if (nums.length === 1) params.set("courseno", nums[0]);
  const instr = $("#f-instructor").value.trim();
  if (instr) params.set("instructor", instr);
  const title = $("#f-title").value.trim();
  if (title) params.set("title", title);
  const secid = $("#f-sectionid").value.trim().split(/[,\s]+/).filter(Boolean)[0];
  if (secid) params.set("sectionid", secid);
  if ($("#f-open").checked) { params.set("onlyopen", "1"); params.set("hidefull", "1"); }

  const filters = {
    nums: nums.length > 1 ? nums.map(n => n.toUpperCase()) : null,
    ranges: $all(".rng").filter(c => c.checked).map(c => c.value),
    days: $all(".day").filter(c => c.checked).map(c => c.value),
    start: $("#f-start").value === "none" ? null : parseTimeMin($("#f-start").value),
    end: $("#f-end").value === "none" ? null : parseTimeMin($("#f-end").value),
  };
  const any = filters.nums || filters.ranges.length || filters.days.length
    || filters.start != null || filters.end != null;
  runSearch(params.toString(), any ? filters : null);
}

async function runSearch(queryString, filters) {
  S.lastSearch = queryString;
  S.clientFilters = filters;
  const qs = new URLSearchParams(queryString);
  qs.set("term", S.term);
  let courses;
  try {
    courses = await api("/api/search?" + qs.toString());
  } catch (e) {
    courses = [];
  }
  S.courses = courses.map(c => ({ ...c, _units: courseUnits(c) }));
  S.page = 1;
  S.open = new Set();
  if (S.courses.length === 1) S.open.add(S.courses[0].id);
  S.resultsShown = true;
  S.panelCollapsed = false;
  $("#results-inner").hidden = false;
  $("#lnk-toggle-results").textContent = "Hide search result";
  $("#results-region").hidden = false;
  renderResults();
}

/* ---------------- client-side result filtering (days/times/number ranges) */

function courseNumInt(num) {
  const m = /^(\d+)/.exec(String(num || "").trim());
  return m ? +m[1] : null;
}

function numMatchesRanges(numText, ranges) {
  const n = courseNumInt(numText);
  if (n == null) return false;
  for (const r of ranges) {
    if (r.endsWith("+")) { if (n >= +r.slice(0, -1)) return true; }
    else if (r.includes("-")) {
      const [lo, hi] = r.split("-").map(Number);
      if (n >= lo && n <= hi) return true;
    } else if (r.includes(",")) {
      if (r.split(",").map(Number).includes(n)) return true;
    } else if (n === +r) return true;
  }
  return false;
}

function unitPassesFilters(unit, f) {
  if (!f) return true;
  const weekly = unit.parents.concat(unit.sec ? [unit.sec] : [])
    .filter(m => m.meeting_type !== "FI");
  if (f.days.length) {
    const sel = new Set(f.days);
    const scheduled = weekly.filter(m => m.days && m.time_start);
    if (!scheduled.length) return false;
    for (const m of scheduled) {
      for (const d of parseDays(m.days)) if (!sel.has(d)) return false;
    }
  }
  if (f.start != null || f.end != null) {
    for (const m of weekly) {
      const a = parseTimeMin(m.time_start), b = parseTimeMin(m.time_end);
      if (a == null || b == null) continue;
      if (f.start != null && a < f.start) return false;
      if (f.end != null && b > f.end) return false;
    }
  }
  return true;
}

function filteredCourses() {
  const f = S.clientFilters;
  if (!S.courses) return [];
  return S.courses.map(c => {
    if (f && f.nums && !f.nums.includes(String(c.course_num).toUpperCase())) return null;
    if (f && f.ranges.length && !numMatchesRanges(c.course_num, f.ranges)) return null;
    const units = f ? c._units.map(g => ({
      ...g, units: g.units.filter(u => unitPassesFilters(u, f)),
    })).filter(g => g.units.length) : c._units;
    if (!units.length) return null;
    return { course: c, groups: units };
  }).filter(Boolean);
}

/* ---------------- grouping course sections into WebReg display units */

function courseUnits(course) {
  const byGroup = {};
  for (const s of course.sections) {
    (byGroup[s.group_code] = byGroup[s.group_code] || []).push(s);
  }
  const bycode = (a, b) => a.section_code.localeCompare(b.section_code);
  return Object.keys(byGroup).sort().map(g => {
    const rows = byGroup[g];
    const finals = rows.filter(r => r.meeting_type === "FI");
    const meetings = rows.filter(r => r.meeting_type !== "FI");
    const notes = [...new Set(rows.map(r => r.note).filter(Boolean))];

    // Which rows carry a Plan button. Normally the enrollable sub-sections.
    // If a course has meeting times but no bookable section (e.g. waitlist-only
    // grad classes), still let it be planned: plan its discussion/lab rows, or
    // the lecture itself if that's all it has.
    let plannable = meetings.filter(r => r.enrollable);
    if (!plannable.length) {
      const subs = meetings.filter(r => r.meeting_type !== "LE");
      plannable = subs.length ? subs : meetings.slice();
    }
    plannable = plannable.slice().sort(bycode);
    const parents = meetings.filter(r => !plannable.includes(r)).sort(bycode);

    const units = plannable.map(e => ({ parents, sec: e, finals }));
    return { group: g, units, finals, notes };
  }).filter(g => g.units.length || g.finals.length);
}

/* ================================================================ results render */

function renderResults() {
  const list = filteredCourses();
  const n = list.length;
  const foundText = n + (n === 1 ? " course found" : " courses found");
  $("#found-count").textContent = foundText;
  /* WCAG 4.1.3 Status Messages — tell screen-reader users the result
     count changed without moving their focus off the search box. */
  announce(foundText + ".");

  const pages = Math.max(1, Math.ceil(n / S.pageSize));
  if (S.page > pages) S.page = pages;
  renderPager(pages);

  const slice = list.slice((S.page - 1) * S.pageSize, S.page * S.pageSize);
  const body = $("#results-body");
  body.innerHTML = "";
  body.hidden = S.panelCollapsed;

  if (!slice.length) {
    body.innerHTML = '<div style="padding:10px;font-size:11px;">No courses matched your search.</div>';
    return;
  }
  for (const entry of slice) body.appendChild(renderDrawer(entry));
}

/*
  WCAG 2.1.1 Keyboard + 4.1.2 Name, Role, Value. Pagination used to be
  built out of <span class="pg"> elements — visually identical to
  buttons (the .pg CSS class doesn't care what tag it's on), but a
  <span> is never in the tab order and carries no button semantics, so
  this whole pager was mouse-only. Switched to real <button> elements;
  aria-current="page" replaces the plain ".cur" styling class as the
  thing that actually tells assistive tech which page you're on (the
  visual "cur" look stays exactly the same, since CSS can key off
  [aria-current="page"] just as easily as .cur — see webreg.css).
*/
function renderPager(pages) {
  const pager = $("#pager");
  pager.innerHTML = "";
  const ARIA_LABEL = { "&laquo;": "Previous page", "&raquo;": "Next page" };
  function btn(label, page, cls, disabled) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pg " + (cls || "");
    b.innerHTML = label;
    if (ARIA_LABEL[label]) b.setAttribute("aria-label", ARIA_LABEL[label]);
    if (cls === "cur") b.setAttribute("aria-current", "page");
    if (disabled) { b.classList.add("off"); b.disabled = true; }
    else b.addEventListener("click", () => { S.page = page; renderResults(); });
    pager.appendChild(b);
  }
  btn("First", 1, "", S.page === 1);
  btn("&laquo;", Math.max(1, S.page - 1), "arrow", S.page === 1);
  let lo = Math.max(1, S.page - 3), hi = Math.min(pages, lo + 6);
  lo = Math.max(1, hi - 6);
  for (let p = lo; p <= hi; p++) {
    if (p === S.page) btn(String(p), p, "cur", true);
    else btn(String(p), p);
  }
  btn("&raquo;", Math.min(pages, S.page + 1), "arrow", S.page === pages);
  btn("Last", pages, "", S.page === pages);
}

/*
  WCAG 2.1.1 Keyboard + 4.1.2 Name, Role, Value. Each course drawer
  header used to be a <div class="drawer-hd"> with only a click
  listener — a mouse-only disclosure widget with no way to tell (short
  of trial and error) whether it was open or closed. Now it's a real
  <button> (native keyboard support, no reinventing Enter/Space
  handling) with aria-expanded reflecting S.open, and aria-controls
  pointing at the drawer body it reveals. The .tri triangle glyph is
  purely decorative (the aria-expanded state already says open/closed),
  so it's marked aria-hidden — WCAG 1.1.1 Non-text Content.
*/
function renderDrawer(entry) {
  const c = entry.course;
  const d = document.createElement("div");
  d.className = "drawer" + (S.open.has(c.id) ? " open" : "");
  const isOpen = S.open.has(c.id);
  const bodyId = "drawer-body-" + c.id;
  const hd = document.createElement("button");
  hd.type = "button";
  hd.className = "drawer-hd";
  hd.setAttribute("aria-expanded", String(isOpen));
  hd.setAttribute("aria-controls", bodyId);
  hd.innerHTML = '<span class="tri" aria-hidden="true"></span>'
    + '<span class="drawer-code">' + esc(c.subject_code) + " " + esc(c.course_num) + "</span>"
    + '<span class="drawer-title">' + esc(c.title) + " " + esc(unitsSuffix(c.units)) + "</span>";
  hd.addEventListener("click", () => {
    if (S.open.has(c.id)) S.open.delete(c.id); else S.open.add(c.id);
    renderResults();
  });
  d.appendChild(hd);
  if (isOpen) {
    const bodyEl = document.createElement("div");
    bodyEl.id = bodyId;
    bodyEl.className = "drawer-body";
    bodyEl.appendChild(renderCourseLinks(c));
    bodyEl.appendChild(renderSectionTable(entry));
    d.appendChild(bodyEl);
  }
  return d;
}

function renderCourseLinks(c) {
  const div = document.createElement("div");
  div.className = "course-links";
  const cat = "https://catalog.ucsd.edu/courses/" + encodeURIComponent(c.subject_code) + ".html";
  div.innerHTML =
    '<a href="' + cat + '" target="_blank" rel="noopener">Catalog <span class="popout"></span></a>'
    + ' | <a href="' + cat + '" target="_blank" rel="noopener">Prerequisites <span class="popout"></span></a>'
    + ' | <a href="https://ucsandiegobookstore.com/" target="_blank" rel="noopener">Resources <span class="popout"></span></a>'
    + ' | <a href="https://cape.ucsd.edu/" target="_blank" rel="noopener">Evaluations <span class="popout"></span></a>';
  return div;
}

const SEC_COLS = ["Section Number", "Section", "Meeting Type", "Days", "Time", "Building",
  "Room", "Avail Seats", "Total Seats", "Waitlist Count", "Book", "Instructor", "Action"];

function renderSectionTable(entry) {
  const c = entry.course;
  const table = document.createElement("table");
  table.className = "sec-table";
  /* scope="col" — WCAG 1.3.1 Info and Relationships. These tables use
     rowspan heavily (one course can span several meeting rows), which
     is exactly the case where a screen reader needs an explicit
     row/column relationship instead of guessing from position; scope
     is the cheapest version of that fix (a full headers/id mapping per
     cell would be more precise but is a lot of markup for a table this
     dense — scope="col" at least gets every data cell associated with
     its column header, which was previously not guaranteed at all). */
  const thead = "<thead><tr>" + SEC_COLS.map(h => '<th scope="col">' + h + "</th>").join("") + "</tr></thead>";
  let html = thead + "<tbody>";

  for (const g of entry.groups) {
    for (const note of g.notes) {
      html += '<tr class="noterow"><td colspan="13">&#9432; Course Note: ' + esc(note) + "</td></tr>";
    }
    for (const unit of g.units) {
      html += unitRowsHtml(c, unit);
    }
    for (const fi of g.finals) {
      html += '<tr class="finalrow">'
        + '<td class="final-lab">FINAL</td><td></td><td></td>'
        + "<td>" + esc(finalWeekday(fi.days)) + "</td>"
        + "<td>" + timeRange(fi) + "</td>"
        + "<td>" + orTBA(fi.building) + "</td><td>" + orTBA(fi.room) + "</td>"
        + "<td></td><td></td><td></td><td></td><td></td>"
        + '<td class="final-date">' + esc(finalDate(fi.days)) + "</td>"
        + "</tr>";
    }
  }
  html += "</tbody>";
  /* WCAG 1.3.1 — a visually-hidden <caption> gives this table a name a
     screen reader announces before reading any cells ("Sections for
     CSE 100, Data Structures and Object-Oriented Design"), instead of
     the table just starting mid-context. Doesn't affect the visual
     layout since .sr-only clips it off-screen. */
  html = '<caption class="sr-only">Sections for ' + esc(c.subject_code + " " + c.course_num) + ", "
    + esc(c.title) + "</caption>" + html;
  table.innerHTML = html;

  $all("button[data-act]", table).forEach(b => {
    b.addEventListener("click", () => {
      const secPk = +b.dataset.sec;
      const unit = findUnit(entry, secPk);
      if (!unit) return;
      openConfirm(b.dataset.act, c, unit);
    });
  });
  return table;
}

function isSectionPlanned(secPk) {
  return S.schedule.some(it => it.section_pk === secPk);
}

function findUnit(entry, secPk) {
  for (const g of entry.groups) {
    for (const u of g.units) if (u.sec && u.sec.id === secPk) return u;
  }
  return null;
}

function meetingCells(m) {
  return "<td>" + esc(m.section_code) + "</td>"
    + "<td>" + esc(m.meeting_type) + "</td>"
    + "<td>" + orTBA(m.days) + "</td>"
    + "<td>" + timeRange(m) + "</td>"
    + "<td>" + orTBA(m.building) + "</td>"
    + "<td>" + orTBA(m.room) + "</td>";
}

function instructorHtml(name) {
  if (!name) return "Staff";
  if (/^staff$/i.test(name.trim())) return "Staff";
  return esc(name);
}

/* component rows print in section-code order (A00 LE, then A01 DI...) like
   real WebReg — regardless of which row carries the button (UI_SPEC §7) */
function unitMeetingRows(unit) {
  return unit.parents.concat(unit.sec ? [unit.sec] : [])
    .sort((a, b) => String(a.section_code).localeCompare(String(b.section_code)));
}

function unitRowsHtml(course, unit) {
  const meetings = unitMeetingRows(unit);
  const span = meetings.length;
  const sec = unit.sec;
  const instr = (meetings.map(m => m.instructor).find(Boolean)) || "Staff";

  let availCell, actionCell;
  if (!sec) {
    availCell = "<td rowspan=\"" + span + "\"></td>";
    actionCell = "<td rowspan=\"" + span + "\"></td>";
  } else if (sec.cancelled) {
    availCell = '<td rowspan="' + span + '" class="cancelled">Cancelled</td>';
    actionCell = "<td rowspan=\"" + span + "\"></td>";
  } else {
    // TSS uses 999/9998/9999 as a "no cap" sentinel (independent study,
    // research, etc.) — show those as TBA, not a giant number.
    const sentinel = isSentinelSeats(sec.seats_limit) || isSentinelSeats(sec.seats_avail);
    const hasSeats = sec.seats_limit != null || sec.seats_avail != null;
    const full = !sentinel && hasSeats && (sec.seats_avail || 0) <= 0;
    availCell = sentinel
      ? '<td rowspan="' + span + '">TBA</td>'
      : !hasSeats
        ? '<td rowspan="' + span + '"></td>'
        : full
          ? '<td rowspan="' + span + '"><span class="full-red">FULL Waitlist(' + (sec.waitlist_ct || 0) + ")</span></td>"
          : '<td rowspan="' + span + '">' + sec.seats_avail + "</td>";
    /* planning-only: Plan the section, or show a dark "Planned" chip once it's
       on your schedule (can't plan the same section twice). */
    const planned = isSectionPlanned(sec.id);
    actionCell = '<td rowspan="' + span + '" class="act">'
      + (planned
        ? '<span class="btn btn-sm planned-chip">Planned</span>'
        : '<button class="btn btn-sm" data-act="plan" data-sec="' + sec.id + '">Plan</button>')
      + "</td>";
  }

  let html = "<tr>";
  html += '<td rowspan="' + span + '">' + esc(sec ? sec.section_id : "") + "</td>";
  html += meetingCells(meetings[0]);
  html += availCell;
  html += '<td rowspan="' + span + '">' + seatsDisplay(sec && sec.seats_limit) + "</td>";
  html += '<td rowspan="' + span + '">' + (sec ? (sec.waitlist_ct || 0) : "") + "</td>";
  /* This link's only visible content was a CSS icon glyph (.bookico, a
     background-image with no text) — which gives it no accessible name
     at all (WCAG 2.4.4 Link Purpose, 4.1.2 Name, Role, Value). A screen
     reader would've announced it as just "link" with nothing to say
     what it links to. aria-label supplies the name that was missing;
     .bookico itself gets aria-hidden since it's decorative once the
     link has a real name. */
  html += '<td rowspan="' + span + '"><a href="https://ucsandiegobookstore.com/" target="_blank" rel="noopener" aria-label="Buy course materials at the UC San Diego Bookstore (opens in a new tab)">'
    + '<span class="bookico" aria-hidden="true"></span></a></td>';
  html += '<td rowspan="' + span + '">' + instructorHtml(instr) + "</td>";
  html += actionCell;
  html += "</tr>";
  for (let i = 1; i < meetings.length; i++) {
    html += "<tr>" + meetingCells(meetings[i]) + "</tr>";
  }
  return html;
}

/* ================================================================ schedule */

async function refreshSchedule() {
  try {
    S.schedule = await api("/api/schedule?term=" + encodeURIComponent(S.term));
  } catch (e) {
    S.schedule = [];
  }
  try {
    const sch = await api("/api/schedules");
    S.evSched = sch.active || "My Schedule";
  } catch (e) {
    S.evSched = "My Schedule";   // single-schedule backend (Flask dev)
  }
  S.schedule = S.schedule.concat(customEventItems());
  renderSchedule();
  updateMapGlow();
  // keep the results grid's Plan/Planned state in sync with the schedule
  if (S.courses && !$("#results-region").hidden) renderResults();
}

function updateMapGlow() {
  const mapTab = $('.tab[data-view="map"]');
  if (!mapTab) return;
  // glow only once there are 2+ planned classes (when walking distances become
  // useful) and the user hasn't opened the Map tab yet
  const seen = localStorage.getItem("webreg_map_seen") === "1";
  mapTab.classList.toggle("glow-new", !seen && S.schedule.length >= 2);
}

/*
  List / Calendar / Finals / Map are now real <button role="tab">
  elements inside a role="tablist" (index.html) instead of plain
  <div class="tab">s, so this needed two things per the WAI-ARIA
  Authoring Practices Tabs pattern (WCAG 2.1.1 Keyboard, 4.1.2 Name,
  Role, Value):
    1. aria-selected kept in sync with which tab is active (not just
       the .active CSS class, which is invisible to a screen reader).
    2. Left/Right arrow keys move between tabs, wrapping around, with
       only the active tab left in the Tab order (roving tabindex —
       tabindex="0" on the selected tab, "-1" on the rest). That's what
       lets a screen-reader/keyboard user reach "Map" with two key
       presses instead of Tabbing past every button on the page to get
       there, and matches how tabs behave in every native OS.
*/
function activateTab(tab) {
  S.view = tab.dataset.view;
  if (tab.dataset.view === "map") {
    tab.classList.remove("glow-new");
    localStorage.setItem("webreg_map_seen", "1");
  }
  $all(".tab").forEach(x => {
    const on = x === tab;
    x.classList.toggle("active", on);
    x.setAttribute("aria-selected", String(on));
    x.tabIndex = on ? 0 : -1;
  });
  renderSchedule();
}

function wireScheduleChrome() {
  const tabs = $all(".tab");
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => { activateTab(t); t.focus(); });
    t.addEventListener("keydown", e => {
      let next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); activateTab(next); next.focus(); }
    });
  });
  $("#lnk-add-event").addEventListener("click", () => openEventModal(null));
  $("#lnk-print").addEventListener("click", () => window.print());
  $("#lnk-appt").addEventListener("click", openAppointment);
  $("#sched-name").addEventListener("change", onSchedNameChange);
}

function itemCode(it) { return it.custom ? it.title : it.subject_code + " " + it.course_num; }

function itemWeeklyMeetings(it) {
  return it.meetings.filter(m => m.meeting_type !== "FI");
}
function itemFinal(it) {
  return it.meetings.find(m => m.meeting_type === "FI") || null;
}
function chosenSection(it) {
  return it.meetings.find(m => m.id === it.section_pk) || null;
}

/* conflict detection across the whole schedule */
function computeConflicts() {
  const pairs = [];
  const conflictKeys = new Set(); // "item_id:meeting_id"
  const items = S.schedule;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      let clash = false;
      for (const ma of itemWeeklyMeetings(a)) {
        for (const mb of itemWeeklyMeetings(b)) {
          if (meetingsOverlap(ma, mb)) {
            clash = true;
            conflictKeys.add(a.item_id + ":" + ma.id);
            conflictKeys.add(b.item_id + ":" + mb.id);
          }
        }
      }
      if (clash) pairs.push(itemCode(a) + " and " + itemCode(b));
      const fa = itemFinal(a), fb = itemFinal(b);
      if (fa && fb && finalDate(fa.days) && finalDate(fa.days) === finalDate(fb.days)
          && timesOverlap(fa, fb)) {
        pairs.push(itemCode(a) + " Final and " + itemCode(b) + " Final");
        conflictKeys.add(a.item_id + ":" + fa.id);
        conflictKeys.add(b.item_id + ":" + fb.id);
      }
    }
  }
  return { pairs, conflictKeys };
}

function timesOverlap(x, y) {
  const a1 = parseTimeMin(x.time_start), a2 = parseTimeMin(x.time_end);
  const b1 = parseTimeMin(y.time_start), b2 = parseTimeMin(y.time_end);
  if (a1 == null || a2 == null || b1 == null || b2 == null) return false;
  return a1 < b2 && b1 < a2;
}

function meetingsOverlap(x, y) {
  if (!x.days || !y.days) return false;
  const dx = parseDays(x.days), dy = new Set(parseDays(y.days));
  if (!dx.some(d => dy.has(d))) return false;
  return timesOverlap(x, y);
}

function candidateConflicts(meetings, excludeItemId, excludeCourseId) {
  const pairs = [];
  for (const it of S.schedule) {
    if (it.item_id === excludeItemId) continue;
    if (excludeCourseId != null && it.course_id === excludeCourseId) continue;
    const code = itemCode(it);
    let clash = false;
    for (const m of meetings.filter(m => m.meeting_type !== "FI")) {
      for (const om of itemWeeklyMeetings(it)) if (meetingsOverlap(m, om)) clash = true;
    }
    if (clash) pairs.push([code, false]);
    const cf = meetings.find(m => m.meeting_type === "FI");
    const of_ = itemFinal(it);
    if (cf && of_ && finalDate(cf.days) && finalDate(cf.days) === finalDate(of_.days)
        && timesOverlap(cf, of_)) {
      pairs.push([code, true]);
    }
  }
  return pairs;
}

function renderConflictBanner() {
  const { pairs } = computeConflicts();
  const el = $("#conflict-banner");
  if (!pairs.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.className = "conflict-banner";
  el.hidden = false;
  /* The warning-triangle glyphs throughout this file (.warn-tri /
     .ok-circ) are CSS-drawn shapes with no semantic content of their
     own — the text right next to them ("You have scheduling
     conflicts!", "Request Failed", etc.) already says what's going on.
     aria-hidden="true" keeps a screen reader from announcing something
     like "graphic, graphic" with no useful information (WCAG 1.1.1
     Non-text Content: decorative images/icons should be hidden from
     the accessibility tree rather than exposed with no name). */
  el.innerHTML = '<div class="hd"><span class="warn-tri" aria-hidden="true"></span>You have scheduling conflicts!</div>'
    + "<ul>" + pairs.map(p => "<li>" + esc(p) + "</li>").join("") + "</ul>"
    + "You are responsible for resolving time conflicts, which may also include conflicts "
    + "in the midterm or final exam schedules. Special accommodations are not guaranteed. "
    + "Review your Calendar and Final Tab now.";
}

function renderTotalUnits() {
  const el = $("#sched-units");
  if (!el) return;
  const classes = S.schedule.filter(it => !it.custom);
  if (!classes.length) { el.hidden = true; el.innerHTML = ""; return; }
  const total = classes.reduce((sum, it) => sum + (+it.units || 0), 0);
  el.hidden = false;
  el.innerHTML = "Total units: <b>" + fmtUnitsVal(total) + "</b> ("
    + classes.length + (classes.length === 1 ? " class" : " classes") + ")";
}

function renderSchedule() {
  renderConflictBanner();
  renderTotalUnits();
  $("#view-list").hidden = S.view !== "list";
  $("#view-calendar").hidden = S.view !== "calendar";
  $("#view-finals").hidden = S.view !== "finals";
  $("#view-map").hidden = S.view !== "map";
  if (S.view === "list") renderListView();
  if (S.view === "calendar") renderCalendarView();
  if (S.view === "finals") renderFinalsView();
  if (S.view === "map") renderMapView();
}

/* ---------------- list view */

const LIST_COLS = ["Subject Course", "Title", "Section Code", "Type", "Instructor",
  "Grade Option", "Units", "Days", "Time", "BLDG", "Room", "Status /<br>(Position)", "Action"];

function statusCellText(it) { return it.custom ? "Event" : "Planned"; }

function renderListView() {
  const root = $("#view-list");
  if (!S.schedule.length) {
    root.innerHTML = '<table class="list-table"><thead><tr>'
      /* WCAG 1.3.1 — same scope="col" fix as the section table above */
      + LIST_COLS.map(h => '<th scope="col">' + h + "</th>").join("") + "</tr></thead></table>"
      + '<div class="list-empty">No classes on your schedule for this term. '
      + "Search for classes above, then Plan them.</div>";
    return;
  }
  let html = '<table class="list-table"><thead><tr>'
    + LIST_COLS.map(h => '<th scope="col">' + h + "</th>").join("") + "</tr></thead><tbody>";

  const order = { enrolled: 0, waitlisted: 1, planned: 2, event: 3 };
  const items = [...S.schedule].sort((a, b) =>
    (order[a.status] - order[b.status]) || itemCode(a).localeCompare(itemCode(b)));

  for (const it of items) {
    const cls = "row-" + it.status;
    const weekly = itemWeeklyMeetings(it);
    const fi = itemFinal(it);
    const main = weekly[0] || chosenSection(it);
    const instr = it.custom ? "" : ((it.meetings.map(m => m.instructor).find(Boolean)) || "Staff");
    const sec = chosenSection(it);
    const full = sec && (sec.seats_avail || 0) <= 0;

    /* Same reasoning as the calendar-view buttons (WCAG 4.1.2): the
       table gives some context via cell position, but a disambiguating
       aria-label costs nothing and helps anyone navigating by "jump to
       next button" rather than reading row by row. */
    const rowCode = esc(itemCode(it));
    const act = '<button class="btn btn-sm" data-a="remove" data-id="' + it.item_id + '" aria-label="Remove ' + rowCode + '">Remove</button>'
      + '<button class="btn btn-sm" data-a="change" data-id="' + it.item_id + '" aria-label="Change ' + rowCode + '">Change</button>';

    html += '<tr class="' + cls + '">'
      + '<td class="l"><b>' + esc(itemCode(it)) + "</b></td>"
      + '<td class="l">' + esc(it.title) + "</td>"
      + "<td>" + esc(main ? main.section_code : "") + "</td>"
      + "<td>" + esc(main ? main.meeting_type : "") + "</td>"
      + '<td class="l">' + esc(instr) + "</td>"
      + "<td>" + (it.custom ? "" : esc(GRADE_CODE[it.grade_option] || it.grade_option)) + "</td>"
      + "<td>" + (it.custom ? "" : fmtUnitsVal(it.units)) + "</td>"
      + "<td>" + orTBA(main && main.days) + "</td>"
      + "<td>" + (main ? timeRange(main) : "TBA") + "</td>"
      + "<td>" + orTBA(main && main.building) + "</td>"
      + "<td>" + orTBA(main && main.room) + "</td>"
      + "<td>" + statusCellText(it) + "</td>"
      + '<td class="act">' + act + "</td></tr>";

    for (let i = 1; i < weekly.length; i++) {
      const m = weekly[i];
      html += '<tr class="' + cls + '"><td></td><td></td>'
        + "<td>" + esc(m.section_code) + "</td><td>" + esc(m.meeting_type) + "</td>"
        + "<td></td><td></td><td></td>"
        + "<td>" + orTBA(m.days) + "</td><td>" + timeRange(m) + "</td>"
        + "<td>" + orTBA(m.building) + "</td><td>" + orTBA(m.room) + "</td>"
        + "<td></td><td></td></tr>";
    }
    if (fi) {
      html += '<tr class="' + cls + '"><td></td><td class="l">Final Exam</td>'
        + "<td></td><td>FI</td><td></td><td></td><td></td>"
        + "<td>" + esc(finalWeekday(fi.days)) + " " + esc(finalDate(fi.days)) + "</td>"
        + "<td>" + timeRange(fi) + "</td>"
        + "<td>" + orTBA(fi.building) + "</td><td>" + orTBA(fi.room) + "</td>"
        + "<td></td><td></td></tr>";
    }
  }
  html += "</tbody></table>";
  root.innerHTML = html;
  wireItemButtons(root);
}

function wireItemButtons(root) {
  $all("button[data-a]", root).forEach(b => b.addEventListener("click", () => {
    const it = S.schedule.find(x => x.item_id === +b.dataset.id);
    if (!it) return;
    const a = b.dataset.a;
    if (it.custom) {
      if (a === "remove") openEventRemove(it);
      else if (a === "change") openEventModal(it);
      return;
    }
    if (a === "drop") openDrop(it, false);
    else if (a === "remove") openDrop(it, true);
    else if (a === "change") openChange(it);
    else if (a === "enroll" || a === "waitlist") openUpgrade(it, a);
  }));
}

/* ---------------- calendar view */

/* CAL_START/CAL_END are only the custom-event picker's bounds now; the grids
   themselves size to the planned classes via calRange().
   96px/hour (1.6px/min) is the smallest scale at which a 50-minute class
   fits its full content (time strip, code, room, instructor, Remove/Change)
   with nothing clipped. Blocks shorter than BLOCK_FULL_PX switch to a
   compact layout (strip + code + buttons) and expand on hover. */
const CAL_START = 7 * 60, CAL_END = 22 * 60, PX_PER_HOUR = 96;
const BLOCK_FULL_PX = 78, BLOCK_MIN_PX = 48;
const DAY_ORDER = ["M", "Tu", "W", "Th", "F", "Sa", "Su"];
const DAY_NAMES = { M: "Monday", Tu: "Tuesday", W: "Wednesday", Th: "Thursday",
  F: "Friday", Sa: "Saturday", Su: "Sunday" };

/* visible grid range: one hour before the earliest block to one hour after
   the last one, rounded out to whole hours (empty schedule -> 8am-6pm) */
function calRange(blocks) {
  let lo = Infinity, hi = -Infinity;
  for (const blk of blocks) {
    if (blk.a < lo) lo = blk.a;
    if (blk.b > hi) hi = blk.b;
  }
  if (!isFinite(lo) || !isFinite(hi)) return { start: 8 * 60, end: 18 * 60 };
  return {
    start: Math.max(0, Math.floor((lo - 60) / 60) * 60),
    end: Math.min(24 * 60, Math.ceil((hi + 60) / 60) * 60),
  };
}

function calGutterHtml(startMin, endMin) {
  let g = '<div class="cal-gutter"><div class="gh gh0"></div>';
  for (let h = startMin / 60; h < endMin / 60; h++) {
    const ap = h < 12 ? "am" : "pm";
    const hh = ((h + 11) % 12) + 1;
    g += '<div class="gh">' + hh + ap + "</div>";
  }
  return g + "</div>";
}

function stripTime(t) { return String(t || "").replace(/[ap]m?$/i, ""); }

function statusLabel(st) {
  return st === "enrolled" ? "Enrolled" : st === "waitlisted" ? "Waitlist"
    : st === "event" ? "Event" : "Planned";
}
function blockClass(st) {
  return st === "waitlisted" ? " wl" : st === "planned" ? " pl"
    : st === "event" ? " ev" : "";
}

function calBlockHtml(it, m, conflict, heightPx, topPx, lane) {
  const cls = "cal-block" + blockClass(it.status) + (conflict ? " conflict" : "")
    + (heightPx < BLOCK_FULL_PX ? " compact" : "");
  /* aria-label on each — WCAG 2.4.6 Headings and Labels / 4.1.2. A
     calendar full of "Remove" / "Change" buttons with no other
     distinguishing text is exactly the situation where a screen-reader
     user's "list all buttons on this page" shortcut becomes useless —
     every entry reads the same. Folding the course code into the label
     ("Remove CSE 100 from schedule") makes each one unique out of
     context, without changing what's visibly printed on the button. */
  const code = esc(itemCode(it));
  const btns = '<button class="btn btn-sm" data-a="remove" data-id="' + it.item_id + '" aria-label="Remove ' + code + ' from schedule">Remove</button>'
    + '<button class="btn btn-sm" data-a="change" data-id="' + it.item_id + '" aria-label="Change ' + code + '">Change</button>';
  /* conflicting blocks overlap with a cascade offset, like real WebReg (D-p16) */
  const laneCss = lane && lane.n > 1
    ? "left:calc(" + (lane.i * 16) + "% + 2px);right:calc(" + ((lane.n - 1 - lane.i) * 16)
      + "% + 2px);z-index:" + (5 + lane.i) + ";"
    : "";
  const detail = it.custom
    ? '<div class="bl">' + (m.building ? esc(m.building) : "Your event") + "</div>"
    : '<div class="bl">' + esc(m.meeting_type) + " / " + orTBA(m.building) + " " + esc(m.room || "") + "</div>"
      + '<div class="bl">' + esc((m.instructor || it.meetings.map(x => x.instructor).find(Boolean) || "Staff")) + "</div>";
  return '<div class="' + cls + '" style="top:' + topPx + "px;height:" + heightPx + "px;" + laneCss + '">'
    + '<div class="strip"><span>' + stripTime(m.time_start) + " - " + stripTime(m.time_end)
    + "</span><span>" + statusLabel(it.status) + "</span></div>"
    + '<div class="bl bcode">' + esc(itemCode(it)) + "</div>"
    + detail
    + '<div class="bbtns">' + btns + "</div>"
    + "</div>";
}

/* assign side-by-side lanes to overlapping blocks within one day column */
function assignLanes(blocks) {
  const sorted = [...blocks].sort((x, y) => x.a - y.a || x.b - y.b);
  const clusters = [];
  let cur = null, curEnd = -1;
  for (const blk of sorted) {
    if (!cur || blk.a >= curEnd) {
      cur = [];
      clusters.push(cur);
      curEnd = blk.b;
    } else {
      curEnd = Math.max(curEnd, blk.b);
    }
    cur.push(blk);
  }
  for (const cluster of clusters) {
    const laneEnds = [];
    for (const blk of cluster) {
      let lane = laneEnds.findIndex(end => blk.a >= end);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = blk.b;
      blk.lane = { i: lane, n: 1 };
    }
    for (const blk of cluster) blk.lane.n = laneEnds.length;
  }
}

function renderCalendarView() {
  const root = $("#view-calendar");
  const { conflictKeys } = computeConflicts();
  const byDay = {};
  for (const d of DAY_ORDER) byDay[d] = [];
  const unscheduled = [];

  for (const it of S.schedule) {
    for (const m of itemWeeklyMeetings(it)) {
      const a = parseTimeMin(m.time_start), b = parseTimeMin(m.time_end);
      const days = parseDays(m.days);
      if (a == null || b == null || !days.length) {
        unscheduled.push({ it, m });
        continue;
      }
      for (const d of days) {
        if (byDay[d]) byDay[d].push({ it, m, a, b });
      }
    }
  }

  const range = calRange(DAY_ORDER.flatMap(d => byDay[d]));
  let html = '<div class="cal-wrap"><div class="cal-grid">' + calGutterHtml(range.start, range.end);
  const bodyH = (range.end - range.start) / 60 * PX_PER_HOUR;
  for (const d of DAY_ORDER) {
    byDay[d].sort((x, y) => x.a - y.a || x.b - y.b);
    assignLanes(byDay[d]);
    html += '<div class="cal-col"><div class="cal-col-hd">' + DAY_NAMES[d] + "</div>"
      + '<div class="cal-body" style="height:' + bodyH + 'px">';
    for (const blk of byDay[d]) {
      const top = (blk.a - range.start) / 60 * PX_PER_HOUR;
      // block height = the class's real duration (1.6px per minute); at this
      // scale a 50-min class fits every line + buttons. Sub-30-min blocks
      // clamp to BLOCK_MIN_PX and render compact (expand on hover).
      const h = Math.max(BLOCK_MIN_PX, (blk.b - blk.a) / 60 * PX_PER_HOUR);
      const conflict = conflictKeys.has(blk.it.item_id + ":" + blk.m.id);
      html += calBlockHtml(blk.it, blk.m, conflict, h, top, blk.lane);
    }
    html += "</div></div>";
  }
  html += "</div>";
  if (unscheduled.length) {
    html += '<div class="cal-unsched"><b>Unscheduled (TBA):</b>'
      + unscheduled.map(u => '<span class="us-item">' + esc(itemCode(u.it)) + " "
        + esc(u.m.section_code) + " " + esc(u.m.meeting_type) + " TBA</span>").join("")
      + "</div>";
  }
  html += "</div>";
  root.innerHTML = html;
  wireItemButtons(root);
}

/* ---------------- finals view */

function renderFinalsView() {
  const root = $("#view-finals");
  const { conflictKeys } = computeConflicts();
  const finals = [];
  for (const it of S.schedule) {
    const fi = itemFinal(it);
    if (fi && finalDate(fi.days)) finals.push({ it, fi });
  }
  if (!finals.length) {
    root.innerHTML = '<div class="list-empty" style="border-top:1px solid #0A4A65">'
      + "No final exams on your schedule for this term.</div>";
    return;
  }
  /* finals-week columns run Saturday -> Saturday like real WebReg (D-p17) */
  const parsed = finals.map(f => new Date(finalDate(f.fi.days)))
    .filter(d => !isNaN(d)).sort((a, b) => a - b);
  const anchor = new Date(parsed[0]);
  anchor.setDate(anchor.getDate() - ((anchor.getDay() + 1) % 7)); // back to Saturday
  const cols = [];
  for (const off of [0, 2, 3, 4, 5, 6, 7]) { // Sat, Mon..Fri, Sat (skip Sunday)
    const d = new Date(anchor);
    d.setDate(d.getDate() + off);
    cols.push(d);
  }
  const fmtD = d => (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear();
  const sameDay = (str, d) => {
    const x = new Date(str);
    return !isNaN(x) && x.toDateString() === d.toDateString();
  };

  const range = calRange(finals
    .map(f => ({ a: parseTimeMin(f.fi.time_start), b: parseTimeMin(f.fi.time_end) }))
    .filter(t => t.a != null && t.b != null));
  let html = '<div class="cal-wrap"><div class="cal-grid">' + calGutterHtml(range.start, range.end);
  const bodyH = (range.end - range.start) / 60 * PX_PER_HOUR;
  for (const col of cols) {
    const label = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][col.getDay()];
    html += '<div class="cal-col"><div class="cal-col-hd two">' + label
      + "<small>" + fmtD(col) + "</small></div>"
      + '<div class="cal-body" style="height:' + bodyH + 'px">';
    for (const f of finals.filter(f => sameDay(finalDate(f.fi.days), col))) {
      const a = parseTimeMin(f.fi.time_start), b = parseTimeMin(f.fi.time_end);
      if (a == null || b == null) continue;
      const top = (a - range.start) / 60 * PX_PER_HOUR;
      const h = Math.max(BLOCK_MIN_PX, (b - a) / 60 * PX_PER_HOUR);
      const conflict = conflictKeys.has(f.it.item_id + ":" + f.fi.id);
      const cls = "cal-block" + blockClass(f.it.status) + (conflict ? " conflict" : "");
      html += '<div class="' + cls + '" style="top:' + top + "px;height:" + h + 'px">'
        + '<div class="strip"><span>' + stripTime(f.fi.time_start) + " - "
        + stripTime(f.fi.time_end) + "</span><span>" + statusLabel(f.it.status) + "</span></div>"
        + '<div class="bl bdate">' + esc(finalDate(f.fi.days)) + "</div>"
        + '<div class="bl bcode">' + esc(itemCode(f.it)) + "</div>"
        + '<div class="bl">' + (f.fi.building && f.fi.building !== "TBA"
          ? esc(f.fi.building + " " + (f.fi.room || "")) : "Location - TBA") + "</div>"
        + '<div class="bl">' + esc(f.it.meetings.map(x => x.instructor).find(Boolean) || "Staff") + "</div>"
        + "</div>";
    }
    html += "</div></div>";
  }
  html += "</div></div>";
  root.innerHTML = html;
}

/* ---------------- map view (campus map + walking distances) */

/* UCSD residential neighborhoods (representative coords) — optional home pin */
const DORMS = [
  { name: "Revelle College", lat: 32.8742, lng: -117.2420 },
  { name: "John Muir College", lat: 32.8792, lng: -117.2432 },
  { name: "Sixth College", lat: 32.8813, lng: -117.2432 },
  { name: "Thurgood Marshall College", lat: 32.8832, lng: -117.2414 },
  { name: "Earl Warren College", lat: 32.8840, lng: -117.2325 },
  { name: "Eleanor Roosevelt College (ERC)", lat: 32.8853, lng: -117.2418 },
  { name: "Seventh College (North Torrey Pines)", lat: 32.8880, lng: -117.2425 },
  { name: "Eighth College (Theatre District)", lat: 32.8721, lng: -117.2419 },
  { name: "Pepper Canyon West (towers)", lat: 32.8776, lng: -117.2327 },
  { name: "Pepper Canyon East apartments", lat: 32.8790, lng: -117.2298 },
  { name: "Rita Atkinson Residences", lat: 32.8722, lng: -117.2355 },
  { name: "One Miramar Street (grad/family)", lat: 32.8737, lng: -117.2266 },
];
function getDorm() {
  const n = localStorage.getItem("webreg_dorm");
  return n ? DORMS.find(d => d.name === n) || null : null;
}
function setDorm(name) {
  if (name) localStorage.setItem("webreg_dorm", name);
  else localStorage.removeItem("webreg_dorm");
}
function dormControlHtml() {
  const cur = localStorage.getItem("webreg_dorm") || "";
  /* label -> for="dorm-select" (WCAG 1.3.1/4.1.2 — was a <span> with no
     "for" attribute, so the select's accessible name was blank). The
     🏠 emoji is decorative flourish on top of real text, not a
     substitute for it, so it's left alone rather than escaped out —
     screen readers generally either skip emoji or read "house," neither
     of which loses information here since "Where do you live?" already
     says the same thing in words right next to it. */
  return '<div class="map-controls"><label class="mc-label" for="dorm-select">🏠 Where do you live?</label>'
    + '<select id="dorm-select"><option value="">Not on campus / skip</option>'
    + DORMS.map(d => '<option value="' + esc(d.name) + '"'
        + (d.name === cur ? " selected" : "") + ">" + esc(d.name) + "</option>").join("")
    + '</select><span class="mc-hint">adds a home pin + your walk to your first class each day</span></div>';
}

function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "vendor/leaflet.css";      // self-hosted — no external CDN
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "vendor/leaflet.js";
    js.onload = resolve;
    js.onerror = reject;
    document.head.appendChild(js);
  });
}

async function loadBuildings() {
  if (S.buildings) return S.buildings;
  try { S.buildings = await (await fetch("data/buildings.json")).json(); }
  catch (e) { S.buildings = {}; }
  return S.buildings;
}

const WALK_MPS = 1.35, DETOUR = 1.3;   // ~campus walking pace, path-vs-straight factor
function metersBetween(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function walkMinutes(m) { return Math.max(1, Math.round(m * DETOUR / WALK_MPS / 60)); }

/* per-day sequence of located meetings (for pins + back-to-back walks) */
function locatedMeetings(bmap) {
  const byDay = {};
  for (const d of DAY_ORDER) byDay[d] = [];
  for (const it of S.schedule) {
    for (const m of itemWeeklyMeetings(it)) {
      const a = parseTimeMin(m.time_start), b = parseTimeMin(m.time_end);
      const loc = bmap[m.building];
      if (a == null || b == null || !loc) continue;
      for (const d of parseDays(m.days))
        if (byDay[d]) byDay[d].push({ it, m, a, b, loc });
    }
  }
  for (const d of DAY_ORDER) byDay[d].sort((x, y) => x.a - y.a);
  return byDay;
}

async function renderMapView() {
  const root = $("#view-map");
  const bmap = await loadBuildings();

  if (!S.schedule.length) {
    root.innerHTML = '<div class="list-empty" style="border-top:1px solid #0A4A65">'
      + "Plan some classes and they'll appear on the campus map here, "
      + "with walking times between your back-to-back classes.</div>";
    return;
  }
  if (!root.querySelector("#leaflet-map")) {
    root.innerHTML = dormControlHtml()
      + '<div id="leaflet-map"></div><div id="walk-summary"></div>';
    $("#dorm-select").addEventListener("change", e => {
      setDorm(e.target.value);
      renderMapView();
    });
  }
  try { await ensureLeaflet(); }
  catch (e) {
    root.innerHTML = '<div class="list-empty">Couldn\'t load the map (network blocked). '
      + "Your class buildings: " + esc(distinctBuildings(bmap).join(", ")) + "</div>";
    return;
  }

  // one marker per distinct building, popup lists the classes there
  const pins = {};
  for (const it of S.schedule) {
    for (const m of itemWeeklyMeetings(it)) {
      const loc = bmap[m.building];
      if (!loc) continue;
      const p = (pins[m.building] = pins[m.building] || { loc, list: [], codes: new Map() });
      const code = itemCode(it);
      if (!p.codes.has(code)) p.codes.set(code, new Set());
      p.codes.get(code).add(TYPE_LONG[m.meeting_type] || m.meeting_type);
      p.list.push(itemCode(it) + " " + m.meeting_type + " · " + (m.days || "") + " " + timeRange(m)
        + (m.room ? " · " + m.building + " " + m.room : ""));
    }
  }

  if (!S.map) {
    S.map = L.map("leaflet-map", { scrollWheelZoom: false })
      .setView([32.8801, -117.2340], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(S.map);
    S.mapLayer = L.layerGroup().addTo(S.map);
  }
  S.mapLayer.clearLayers();

  const pts = [];
  for (const [name, p] of Object.entries(pins)) {
    // vector marker (no image assets) with a label
    const mk = L.circleMarker([p.loc.lat, p.loc.lng], {
      radius: 8, color: "#0A4A65", weight: 2,
      fillColor: "#CB6C12", fillOpacity: 0.9,
    }).addTo(S.mapLayer);
    mk.bindPopup("<b>" + escHtml(name) + "</b><br>" + p.list.map(escHtml).join("<br>"));
    mk.bindTooltip([...p.codes].map(([c, types]) =>
      escHtml(c + " · " + [...types].join(", "))).join("<br>"),
      { permanent: true, direction: "right", className: "map-lbl", offset: [8, 0] });
    pts.push([p.loc.lat, p.loc.lng]);
  }

  // optional home pin (green) if the user set a dorm
  const dorm = getDorm();
  if (dorm) {
    L.circleMarker([dorm.lat, dorm.lng], {
      radius: 9, color: "#0f5c2e", weight: 2, fillColor: "#2fb457", fillOpacity: 0.95,
    }).addTo(S.mapLayer)
      .bindTooltip("🏠 " + escHtml(dorm.name),
        { permanent: true, direction: "right", className: "map-lbl dorm-lbl", offset: [9, 0] });
    pts.push([dorm.lat, dorm.lng]);
  }

  // walking segments per day: home → first class, then back-to-back
  const byDay = locatedMeetings(bmap);
  const walks = [];
  for (const d of DAY_ORDER) {
    const seq = byDay[d];
    if (!seq.length) continue;
    if (dorm) {
      const first = seq[0];
      const dist = metersBetween(dorm, first.loc), walk = walkMinutes(dist);
      L.polyline([[dorm.lat, dorm.lng], [first.loc.lat, first.loc.lng]],
        { color: "#2fb457", weight: 3, opacity: 0.75, dashArray: "2 6" }).addTo(S.mapLayer);
      walks.push({ d, kind: "dorm", to: first, dist, walk });
    }
    for (let i = 0; i + 1 < seq.length; i++) {
      const from = seq[i], to = seq[i + 1];
      if (from.loc === to.loc || (from.loc.lat === to.loc.lat && from.loc.lng === to.loc.lng)) continue;
      const dist = metersBetween(from.loc, to.loc);
      const walk = walkMinutes(dist), gap = to.a - from.b;
      L.polyline([[from.loc.lat, from.loc.lng], [to.loc.lat, to.loc.lng]],
        { color: gap >= 0 && walk > gap ? "#C00" : "#0A4A65", weight: 3, opacity: 0.7, dashArray: "6 5" })
        .addTo(S.mapLayer);
      walks.push({ d, kind: "b2b", from, to, dist, walk, gap });
    }
  }

  if (pts.length) S.map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
  setTimeout(() => S.map.invalidateSize(), 60);

  renderWalkSummary(walks);
}

function distinctBuildings(bmap) {
  const s = new Set();
  for (const it of S.schedule)
    for (const m of itemWeeklyMeetings(it)) if (bmap[m.building]) s.add(m.building);
  return [...s];
}

const DAY_FULL = { M: "Monday", Tu: "Tuesday", W: "Wednesday", Th: "Thursday",
  F: "Friday", Sa: "Saturday", Su: "Sunday" };

function renderWalkSummary(walks) {
  const el = $("#walk-summary");
  if (!walks.length) {
    el.innerHTML = '<div class="walk-none">Nothing to walk between yet — plan classes '
      + "(and optionally set your dorm above) to see walking times here.</div>";
    return;
  }
  let html = '<div class="walk-hd">Your walks</div>';
  const byDay = {};
  for (const w of walks) (byDay[w.d] = byDay[w.d] || []).push(w);
  for (const d of DAY_ORDER) {
    if (!byDay[d]) continue;
    html += '<div class="walk-day"><div class="walk-dayname">' + DAY_FULL[d] + "</div>";
    for (const w of byDay[d]) {
      if (w.kind === "dorm") {
        html += '<div class="walk-row dorm">'
          + "<b>🏠 Home</b> → <b>" + escHtml(itemCode(w.to.it)) + "</b> "
          + '<span class="walk-meta">' + escHtml(w.to.m.building)
          + " · " + Math.round(w.dist) + " m · ~" + w.walk + " min walk to your first class</span>"
          + "</div>";
        continue;
      }
      const tight = w.gap >= 0 && w.walk > w.gap;
      html += '<div class="walk-row' + (tight ? " tight" : "") + '">'
        + "<b>" + escHtml(itemCode(w.from.it)) + "</b> → <b>" + escHtml(itemCode(w.to.it)) + "</b> "
        + '<span class="walk-meta">' + escHtml(w.from.m.building) + " → " + escHtml(w.to.m.building)
        + " · " + Math.round(w.dist) + " m · ~" + w.walk + " min walk"
        + (w.gap >= 0 ? " · " + w.gap + " min between classes" : "")
        + "</span> " + (tight ? '<span class="walk-flag">⚠ tight</span>'
                              : '<span class="walk-ok">✓</span>')
        + "</div>";
    }
    html += "</div>";
  }
  el.innerHTML = html;
}

function escHtml(s) { return esc(s); }

/* ================================================================ modals */

/* remembers what had focus before a modal opened, so closeModal() can
   give it back — WCAG 2.4.3 Focus Order. Without this, closing a dialog
   drops keyboard focus back to <body>, and a keyboard user has to
   re-tab from the top of the page to find where they were. */
let lastFocusedBeforeModal = null;

function openModal(innerHtml) {
  const root = $("#modal-root");
  lastFocusedBeforeModal = document.activeElement;
  root.innerHTML = '<div class="modal-box"><div class="modal-title"></div>'
    + '<div class="modal-body">' + innerHtml + "</div></div>";
  root.hidden = false;

  /* Every modal variant titles itself a little differently (.modal-h for
     the confirm/change/event dialogs, .hd inside .result-green/.result-red
     for success/error/warning ones). Whichever is present becomes the
     dialog's accessible name via aria-labelledby (WCAG 4.1.2 Name, Role,
     Value) — a screen reader announces that text immediately on opening
     the dialog, instead of "dialog" with no name, or the first row of
     an unrelated confirmation table. */
  const heading = $(".modal-h, .hd", root) || $(".modal-body", root);
  if (heading) { heading.id = "modal-title-text"; root.setAttribute("aria-labelledby", "modal-title-text"); }

  /* Move focus into the dialog (first focusable control, falling back to
     the dialog itself) — WCAG 2.4.3 Focus Order. Without this, focus
     stays on the button the user just clicked, which is now sitting
     underneath the dialog that just covered it. */
  const focusables = $all(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    root
  );
  (focusables[0] || root).focus();

  document.addEventListener("keydown", modalKeyHandler);
  return root;
}

function modalKeyHandler(e) {
  const root = $("#modal-root");
  if (!root || root.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
  if (e.key === "Tab") trapFocus(root, e);
}

function closeModal() {
  const root = $("#modal-root");
  root.hidden = true;
  root.innerHTML = "";
  document.removeEventListener("keydown", modalKeyHandler);
  /* Return focus to whatever opened the dialog (WCAG 2.4.3 Focus Order).
     Guard against the trigger having disappeared from the DOM (e.g. a
     "Plan" button whose whole results table just re-rendered). */
  if (lastFocusedBeforeModal && document.contains(lastFocusedBeforeModal)) {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

/* ---------------- appointment times */

async function openAppointment() {
  let data = null;
  try { data = await api("/api/appointment?term=" + encodeURIComponent(S.term)); }
  catch (e) { /* endpoint optional */ }
  const fp = (data && data.first_pass) || {};
  const sp = (data && data.second_pass) || {};
  openModal(
    '<div class="appt-cols">'
    + '<div class="col"><b>First Pass</b>'
    + "Start date/time: " + esc(fp.start || "TBA") + "<br>"
    + "End date/time: " + esc(fp.end || "TBA") + "</div>"
    + '<div class="col"><b>Second Pass</b>'
    + "Start date/time: " + esc(sp.start || "TBA") + "<br>"
    + "End date/time: " + esc(sp.end || "TBA") + "</div>"
    + "</div>"
    + '<div class="modal-btns"><button class="btn" id="m-close">Close</button></div>');
  $("#m-close").addEventListener("click", closeModal);
}

/* ---------------- custom events (work, clubs, gym — any weekly block)
   Stored per schedule name in localStorage only (browser + Flask dev alike),
   and presented as schedule-item lookalikes so the list/calendar views and
   the conflict engine work on them unchanged. */

const EV_KEY = "webreg_fa26_events_v1";

function loadEvStore() {
  try {
    const s = JSON.parse(localStorage.getItem(EV_KEY));
    if (s && typeof s === "object") return s;
  } catch (e) { /* corrupt — start fresh */ }
  return {};
}
function saveEvStore(st) { localStorage.setItem(EV_KEY, JSON.stringify(st)); }

function evSchedName() { return S.evSched || "My Schedule"; }
function loadEvents() {
  const rec = loadEvStore()[evSchedName()];
  return rec && Array.isArray(rec.events) ? rec : { seq: 1, events: [] };
}
function saveEvents(rec) {
  const st = loadEvStore();
  st[evSchedName()] = rec;
  saveEvStore(st);
}
/* keep events attached to their schedule through copy / rename / delete */
function migrateEvents(from, to, keepOriginal) {
  const st = loadEvStore();
  if (!st[from] || from === to) return;
  st[to] = keepOriginal ? JSON.parse(JSON.stringify(st[from])) : st[from];
  if (!keepOriginal) delete st[from];
  saveEvStore(st);
}
function deleteEventsFor(name) {
  const st = loadEvStore();
  delete st[name];
  saveEvStore(st);
}

/* negative ids so custom items can never collide with real section/item pks */
function customEventItems() {
  return loadEvents().events.map(ev => ({
    item_id: -ev.id, custom: true, event: ev,
    status: "event", units: 0, grade_option: "", position: null,
    course_id: null, subject_code: ev.title, course_num: "", title: ev.title,
    section_pk: -ev.id, group_code: "", section_code: "", section_id: "",
    meetings: [{
      id: -ev.id, section_code: "", meeting_type: "EV",
      days: ev.days.join(""), time_start: ev.time_start, time_end: ev.time_end,
      building: ev.location || "", room: "", instructor: "",
    }],
  }));
}

/* 15-minute ticks across the calendar grid's visible range (7am–10pm) */
function evTimeOptionsHtml(cur) {
  let html = "";
  for (let t = CAL_START; t <= CAL_END; t += 15) {
    const h24 = Math.floor(t / 60), mm = t % 60;
    const ap = h24 < 12 ? "a" : "p";
    const hh = ((h24 + 11) % 12) + 1;
    const v = hh + ":" + (mm < 10 ? "0" : "") + mm + ap;
    html += '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + v + "m</option>";
  }
  return html;
}

function evErrHtml(msg) {
  return '<div class="result-red" style="margin-top:10px"><div class="hd">'
    + '<span class="warn-tri" aria-hidden="true"></span>' + esc(msg) + "</div></div>";
}

function openEventModal(existing) {
  const ev = existing ? existing.event : null;
  const dayChecks = DAY_ORDER.map(d =>
    '<label><input type="checkbox" class="ev-day" value="' + d + '"'
    + (ev && ev.days.includes(d) ? " checked" : "") + ">" + d + "</label>").join("");

  openModal(
    '<div class="modal-h">' + (ev ? "Confirm changes to your event"
      : "Add an event to your schedule — work, clubs, gym, anything with a weekly time") + "</div>"
    + '<table class="confirm-table ev-form"><tbody>'
    + '<tr><th>Event Name</th><td><input type="text" id="ev-title" maxlength="40" value="'
    + esc(ev ? ev.title : "") + '" placeholder="e.g., Work shift"></td></tr>'
    + '<tr><th>Days</th><td class="ev-days">' + dayChecks + "</td></tr>"
    + '<tr><th>Time</th><td>'
    + '<select id="ev-start">' + evTimeOptionsHtml(ev ? ev.time_start : "9:00a") + "</select>"
    + ' &nbsp;to&nbsp; '
    + '<select id="ev-end">' + evTimeOptionsHtml(ev ? ev.time_end : "10:00a") + "</select></td></tr>"
    + '<tr><th>Location <span class="ev-opt">(optional)</span></th>'
    + '<td><input type="text" id="ev-loc" maxlength="40" value="' + esc(ev ? (ev.location || "") : "")
    + '" placeholder="e.g., Geisel Library"></td></tr>'
    + "</tbody></table>"
    /* role="alert" (implicit aria-live="assertive") — this is where
       "give this event a name," "no seats available," etc. get filled
       in after Confirm. It starts empty so there's nothing to announce
       on open, but once JS fills it in, an alert region announces
       itself automatically without needing a separate announce() call
       — WCAG 4.1.3 Status Messages. */
    + '<div id="m-err" role="alert"></div>'
    + '<div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button>'
    + '<button class="btn" id="m-confirm">' + (ev ? "Confirm" : "Add Event") + "</button></div>");
  $("#m-cancel").addEventListener("click", closeModal);
  $("#ev-title").focus();

  let warned = "";  // conflict alert shown for this exact candidate already
  $("#m-confirm").addEventListener("click", () => {
    const title = $("#ev-title").value.trim();
    const days = $all(".ev-day").filter(c => c.checked).map(c => c.value);
    const start = $("#ev-start").value, end = $("#ev-end").value;
    const loc = $("#ev-loc").value.trim();
    const err = $("#m-err");
    if (!title) { err.innerHTML = evErrHtml("Give your event a name."); return; }
    if (!days.length) { err.innerHTML = evErrHtml("Pick at least one day."); return; }
    if (parseTimeMin(end) <= parseTimeMin(start)) {
      err.innerHTML = evErrHtml("The end time must be after the start time."); return;
    }
    /* same contract as planning a class: warn about conflicts, allow anyway */
    const cand = [{ meeting_type: "EV", days: days.join(""), time_start: start, time_end: end }];
    const pairs = candidateConflicts(cand, existing ? existing.item_id : null, null);
    const sig = JSON.stringify([days, start, end]);
    if (pairs.length && warned !== sig) {
      warned = sig;
      err.innerHTML = conflictAlertHtml(pairs, title)
        + '<div style="margin:6px 2px;font-size:11px">Click <b>'
        + (ev ? "Confirm" : "Add Event") + "</b> again to keep it anyway.</div>";
      return;
    }
    const rec = loadEvents();
    if (ev) {
      const stored = rec.events.find(x => x.id === ev.id);
      if (stored) Object.assign(stored, { title, days, time_start: start, time_end: end, location: loc });
    } else {
      rec.events.push({ id: rec.seq++, title, days, time_start: start, time_end: end, location: loc });
    }
    saveEvents(rec);
    refreshSchedule();
    showSuccess((ev ? "Changed event " : "Added event ") + title + " ("
      + days.join("") + " " + start + "-" + end + ") on your schedule.");
  });
}

function openEventRemove(it) {
  const m = it.meetings[0];
  openModal(
    '<div class="result-red"><div class="hd"><span class="warn-tri" aria-hidden="true"></span>'
    + "You are about to remove this event.</div>"
    + "<b>Remove &ldquo;" + esc(it.title) + "&rdquo; (" + esc(m.days) + " "
    + timeRange(m) + ") from your schedule?</b></div>"
    + '<div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button>'
    + '<button class="btn" id="m-drop">Remove</button></div>');
  $("#m-cancel").addEventListener("click", closeModal);
  $("#m-drop").addEventListener("click", () => {
    const rec = loadEvents();
    rec.events = rec.events.filter(x => x.id !== it.event.id);
    saveEvents(rec);
    refreshSchedule();
    showSuccess("Removed event " + it.title + " from your schedule.");
  });
}

/* ---------------- confirm add (plan / enroll / waitlist) */

const CONFIRM_TITLES = {
  plan: "Confirm class, and/or grading option or units to add this class to your plan",
  enroll: "Confirm class, and/or grading option or units to enroll",
  waitlist: "Confirm class, and/or grading option or units to waitlist",
};

function confirmTableHtml(codeText, title, meetings, unitsText, opts) {
  opts = opts || {};
  const uo = unitOptions(unitsText);
  const gradingCell = opts.plainGrading
    ? esc(GRADE_NAME[opts.grade] || "Letter")
    : '<select id="m-grading">'
      + '<option value="L">Letter</option><option value="P">Pass/No Pass</option>'
      + "</select>";
  const unitsCell = opts.plainUnits
    ? fmtUnitsVal(opts.units != null ? opts.units : uo[0])
    : (uo.length > 1
      ? '<select id="m-units">' + uo.map(v => '<option value="' + v + '">' + fmtUnitsVal(v) + "</option>").join("") + "</select>"
      : '<span id="m-units-fixed" data-v="' + uo[0] + '">' + fmtUnitsVal(uo[0]) + "</span>");

  const span = meetings.length;
  const typeName = m => opts.longTypes ? (TYPE_LONG[m.meeting_type] || m.meeting_type) : m.meeting_type;
  let rows = "<tr>"
    + '<td rowspan="' + span + '">' + esc(codeText) + "</td>"
    + '<td rowspan="' + span + '">' + esc(title) + "</td>"
    + '<td rowspan="' + span + '">' + gradingCell + "</td>"
    + '<td rowspan="' + span + '">' + unitsCell + "</td>"
    + "<td>" + esc(meetings[0].section_code) + "</td><td>" + typeName(meetings[0]) + "</td>"
    + "<td>" + orTBA(meetings[0].days) + "</td><td>" + timeRange(meetings[0]) + "</td></tr>";
  for (let i = 1; i < span; i++) {
    const m = meetings[i];
    rows += "<tr><td>" + esc(m.section_code) + "</td><td>" + typeName(m) + "</td>"
      + "<td>" + orTBA(m.days) + "</td><td>" + timeRange(m) + "</td></tr>";
  }
  /* scope="col" on this confirmation table too — WCAG 1.3.1, same
     reasoning as the section/list tables above. */
  return '<table class="confirm-table"><thead><tr><th scope="col">Subject/Course</th>'
    + '<th scope="col">Course Title</th><th scope="col">Grading</th><th scope="col">Units</th><th scope="col">Section Code</th>'
    + '<th scope="col">Meeting Type</th><th scope="col">Days</th><th scope="col">Time</th></tr></thead><tbody>'
    + rows + "</tbody></table>";
}

function conflictAlertHtml(pairs, candidateCode) {
  if (!pairs.length) return "";
  return '<div class="alert-yellow"><div class="hd"><span class="warn-tri yellow" aria-hidden="true"></span>Alert:</div>'
    + '<div class="red">Warning: You have scheduling conflict!</div><ul>'
    + pairs.map(p => "<li>" + esc(candidateCode + (p[1] ? " Final" : "") + " and "
      + p[0] + (p[1] ? " Final" : "")) + "</li>").join("")
    + "</ul>This section's time conflicts with another course on your schedule. "
    + "You are responsible for resolving time conflicts, which may also include "
    + "conflicts in the midterm or final exam schedule.</div>";
}

function unitMeetings(unit) {
  return unit.parents.concat(unit.sec ? [unit.sec] : []).concat(unit.finals || []);
}

function openConfirm(mode, course, unit) {
  const code = course.subject_code + " " + course.course_num;
  const meetings = unitMeetingRows(unit);
  const pairs = candidateConflicts(unitMeetings(unit), null, course.id);

  openModal(
    '<div class="modal-h">' + CONFIRM_TITLES[mode] + "</div>"
    + conflictAlertHtml(pairs, code)
    + confirmTableHtml(code, course.title, meetings, course.units)
    /* role="alert" (implicit aria-live="assertive") — this is where
       "give this event a name," "no seats available," etc. get filled
       in after Confirm. It starts empty so there's nothing to announce
       on open, but once JS fills it in, an alert region announces
       itself automatically without needing a separate announce() call
       — WCAG 4.1.3 Status Messages. */
    + '<div id="m-err" role="alert"></div>'
    + '<div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button>'
    + '<button class="btn" id="m-confirm">Confirm</button></div>');
  $("#m-cancel").addEventListener("click", closeModal);
  $("#m-confirm").addEventListener("click", async () => {
    const grade = $("#m-grading") ? $("#m-grading").value : "L";
    const unitsEl = $("#m-units");
    const units = unitsEl ? +unitsEl.value : +($("#m-units-fixed").dataset.v);
    const status = mode === "plan" ? "planned" : mode === "waitlist" ? "waitlisted" : "enrolled";
    try {
      await post("/api/schedule/add", {
        term: S.term, section_pk: unit.sec.id, units: String(units),
        grade_option: grade, status,
      });
      await refreshSchedule();
      showSuccess(addSuccessMessage(mode, code, grade, units, unit.sec.section_id));
    } catch (e) {
      showModalError(e, mode, course, unit);
    }
  });
}

function addSuccessMessage(mode, code, grade, units, sectionId) {
  const g = GRADE_NAME[grade] || "Letter";
  const u = fmtUnitsVal(units);
  if (mode === "plan") return "Planned " + code + " with " + g + " grade option for " + u + " units, Section " + sectionId + ".";
  if (mode === "waitlist") return "Waitlisted " + code + " with " + g + " grade option for " + u + " units, Section " + sectionId + ".";
  return "Enrolled in " + code + " with " + g + " grade option for " + u + " units, Section " + sectionId + ".";
}

function showSuccess(message) {
  openModal(
    '<div class="result-green"><div class="hd"><span class="ok-circ" aria-hidden="true">&#10003;</span>Request Successful</div>'
    + esc(message) + "</div>"
    + '<div class="modal-btns"><button class="btn" id="m-close">Close</button></div>');
  $("#m-close").addEventListener("click", closeModal);
}

function showModalError(e, mode, course, unit) {
  const err = $("#m-err");
  const full = unit && unit.sec && (unit.sec.seats_avail || 0) <= 0 && mode === "enroll";
  let html = '<div class="result-red" style="margin-top:12px"><div class="hd">'
    + '<span class="warn-tri" aria-hidden="true"></span>Request Failed</div>' + esc(e.message || "Request failed.");
  if (full) {
    html += '<div style="margin-top:8px">This section is full. You may add yourself to the '
      + 'wait-list instead.</div><div style="margin-top:6px"><button class="btn" id="m-to-wl">'
      + "Add to Waitlist</button></div>";
  }
  html += "</div>";
  if (err) err.innerHTML = html; else openModal(html + '<div class="modal-btns"><button class="btn" id="m-close">Close</button></div>');
  const wl = $("#m-to-wl");
  if (wl) wl.addEventListener("click", () => openConfirm("waitlist", course, unit));
  const cl = $("#m-close");
  if (cl) cl.addEventListener("click", closeModal);
}

/* ---------------- drop / remove */

function openDrop(it, isRemove) {
  const code = itemCode(it);
  const meetings = itemWeeklyMeetings(it);
  const warn = isRemove
    ? '<div class="result-red"><div class="hd"><span class="warn-tri" aria-hidden="true"></span>'
      + "You are about to remove this planned class.</div>"
      + "<b>You will remove all components of this class from your plan.</b><br>"
      + "<b>Are you sure you would like to remove this class?</b></div>"
    : '<div class="result-red"><div class="hd"><span class="warn-tri" aria-hidden="true"></span>'
      + "You are about to drop this class.</div>"
      + "<b>Warning</b>: Academic regulations permit only one 'W' per-course.<br><br>"
      + "If this is your second attempt, WebReg will prohibit the drop.<br><br>"
      + "If this is your first attempt to drop this course, it will result in a 'W' grade on "
      + "your transcript. If you re-enroll in this course in a future quarter, you will not be "
      + "permitted to drop this course again with another W grade on your transcript. See the "
      + '<a href="https://students.ucsd.edu/academics/enrollment/calendars/index.html" '
      + 'target="_blank" rel="noopener">Enrollment and Registration Calendar</a> for official deadlines.<br><br>'
      + "<b>You will be dropped from all components of this class.<br>"
      + "Are you sure you would like to drop this class?</b></div>";

  openModal(warn
    + '<div style="height:12px"></div>'
    + confirmTableHtml(code, it.title, meetings, String(it.units),
      { plainGrading: true, plainUnits: true, longTypes: true,
        grade: it.grade_option, units: it.units })
    + '<div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button>'
    + '<button class="btn" id="m-drop">' + (isRemove ? "Remove" : "Drop") + "</button></div>");
  $("#m-cancel").addEventListener("click", closeModal);
  $("#m-drop").addEventListener("click", async () => {
    try {
      await post("/api/schedule/drop", { item_id: it.item_id });
      await refreshSchedule();
      const verb = it.status === "waitlisted" ? "Dropped wait-listed class "
        : isRemove ? "Removed planned class " : "Dropped ";
      showSuccess(verb + itemCode(it) + " " + it.title + ", Section " + (it.section_id || "") + ".");
    } catch (e) {
      showModalError(e);
    }
  });
}

/* ---------------- change (grading / units / section swap) */

async function fetchCourseEntry(it) {
  const qs = new URLSearchParams({
    term: S.term, subjects: it.subject_code, courseno: it.course_num,
  });
  try {
    const courses = await api("/api/search?" + qs.toString());
    const c = courses.find(x => x.id === it.course_id) || courses[0];
    if (!c) return null;
    return { course: c, groups: courseUnits(c) };
  } catch (e) { return null; }
}

async function openChange(it) {
  const code = itemCode(it);
  const entry = await fetchCourseEntry(it);
  const alts = [];
  if (entry) {
    for (const g of entry.groups) {
      for (const u of g.units) {
        if (u.sec) alts.push(u);
      }
    }
  }
  const uo = unitOptions(entry ? entry.course.units : String(it.units));
  const unitsCell = uo.length > 1
    ? '<select id="m-units">' + uo.map(v =>
        '<option value="' + v + '"' + (+it.units === +v ? " selected" : "") + ">"
        + fmtUnitsVal(v) + "</option>").join("") + "</select>"
    : '<span id="m-units-fixed" data-v="' + (+it.units || uo[0]) + '">' + fmtUnitsVal(+it.units || uo[0]) + "</span>";

  const secSelect = alts.length > 1
    ? '<div style="margin:12px 0 4px"><b>Section:</b> <select id="m-section">'
      + alts.map(u => {
        const m = u.sec;
        const full = (m.seats_avail || 0) <= 0;
        return '<option value="' + m.id + '"' + (m.id === it.section_pk ? " selected" : "") + ">"
          + esc(m.section_code + " " + m.meeting_type + " " + (m.days || "TBA") + " " + timeRange(m)
            + (full ? "  (FULL)" : "")) + "</option>";
      }).join("") + "</select></div>"
    : "";

  const meetings = itemWeeklyMeetings(it);
  openModal(
    '<div class="modal-h">Confirm class, and/or grading option or units to change</div>'
    /* same scope="col" fix — WCAG 1.3.1 */
    + '<table class="confirm-table"><thead><tr><th scope="col">Subject/Course</th><th scope="col">Course Title</th>'
    + '<th scope="col">Grading</th><th scope="col">Units</th><th scope="col">Section Code</th><th scope="col">Meeting Type</th><th scope="col">Days</th>'
    + '<th scope="col">Time</th></tr></thead><tbody>'
    + '<tr><td rowspan="' + meetings.length + '">' + esc(code) + "</td>"
    + '<td rowspan="' + meetings.length + '">' + esc(it.title) + "</td>"
    + '<td rowspan="' + meetings.length + '"><select id="m-grading">'
    + '<option value="L"' + (it.grade_option === "L" ? " selected" : "") + ">Letter</option>"
    + '<option value="P"' + (it.grade_option === "P" ? " selected" : "") + ">Pass/No Pass</option>"
    + "</select></td>"
    + '<td rowspan="' + meetings.length + '">' + unitsCell + "</td>"
    + "<td>" + esc(meetings[0].section_code) + "</td><td>" + esc(meetings[0].meeting_type) + "</td>"
    + "<td>" + orTBA(meetings[0].days) + "</td><td>" + timeRange(meetings[0]) + "</td></tr>"
    + meetings.slice(1).map(m => "<tr><td>" + esc(m.section_code) + "</td><td>"
      + esc(m.meeting_type) + "</td><td>" + orTBA(m.days) + "</td><td>" + timeRange(m) + "</td></tr>").join("")
    + "</tbody></table>"
    + secSelect
    /* role="alert" (implicit aria-live="assertive") — this is where
       "give this event a name," "no seats available," etc. get filled
       in after Confirm. It starts empty so there's nothing to announce
       on open, but once JS fills it in, an alert region announces
       itself automatically without needing a separate announce() call
       — WCAG 4.1.3 Status Messages. */
    + '<div id="m-err" role="alert"></div>'
    + '<div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button>'
    + '<button class="btn" id="m-confirm">Confirm</button></div>');
  $("#m-cancel").addEventListener("click", closeModal);
  $("#m-confirm").addEventListener("click", async () => {
    const payload = { item_id: it.item_id };
    payload.grade_option = $("#m-grading").value;
    const unitsEl = $("#m-units");
    payload.units = String(unitsEl ? +unitsEl.value : +($("#m-units-fixed").dataset.v));
    const secEl = $("#m-section");
    if (secEl && +secEl.value !== it.section_pk) payload.section_pk = +secEl.value;
    try {
      await post("/api/schedule/change", payload);
      await refreshSchedule();
      showSuccess("Changed " + code + " to " + (GRADE_NAME[payload.grade_option] || "Letter")
        + " grade option for " + fmtUnitsVal(payload.units) + " units, Section "
        + (it.section_id || "") + ".");
    } catch (e) {
      showModalError(e);
    }
  });
}

/* ---------------- planned row -> Enroll / Waitlist */

function itemAsUnit(it) {
  const weekly = itemWeeklyMeetings(it);
  const sec = chosenSection(it);
  return {
    parents: weekly.filter(m => m.id !== it.section_pk),
    sec,
    finals: it.meetings.filter(m => m.meeting_type === "FI"),
  };
}

function openUpgrade(it, mode) {
  const code = itemCode(it);
  const unit = itemAsUnit(it);
  const meetings = itemWeeklyMeetings(it);
  const pairs = candidateConflicts(it.meetings, it.item_id, it.course_id);

  openModal(
    '<div class="modal-h">' + CONFIRM_TITLES[mode] + "</div>"
    + conflictAlertHtml(pairs, code)
    + confirmTableHtml(code, it.title, meetings, String(it.units),
      { plainUnits: false })
    /* role="alert" (implicit aria-live="assertive") — this is where
       "give this event a name," "no seats available," etc. get filled
       in after Confirm. It starts empty so there's nothing to announce
       on open, but once JS fills it in, an alert region announces
       itself automatically without needing a separate announce() call
       — WCAG 4.1.3 Status Messages. */
    + '<div id="m-err" role="alert"></div>'
    + '<div class="modal-btns"><button class="btn" id="m-cancel">Cancel</button>'
    + '<button class="btn" id="m-confirm">Confirm</button></div>');
  const g = $("#m-grading");
  if (g) g.value = it.grade_option === "P" ? "P" : "L";
  $("#m-cancel").addEventListener("click", closeModal);
  $("#m-confirm").addEventListener("click", async () => {
    const grade = $("#m-grading") ? $("#m-grading").value : it.grade_option;
    const unitsEl = $("#m-units");
    const units = unitsEl ? +unitsEl.value : +it.units;
    const status = mode === "waitlist" ? "waitlisted" : "enrolled";
    try {
      await post("/api/schedule/drop", { item_id: it.item_id });
      await post("/api/schedule/add", {
        term: S.term, section_pk: it.section_pk, units: String(units),
        grade_option: grade, status,
      });
      await refreshSchedule();
      showSuccess(addSuccessMessage(mode, code, grade, units, it.section_id));
    } catch (e) {
      await refreshSchedule();
      showModalError(e, mode, null, null);
    }
  });
}