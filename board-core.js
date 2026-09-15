// Shared data layer + rendering helpers + interaction wiring for the ops task board.
// Loaded as an ES module by both index.html (active board) and history.html (완료된 일 archive).
// Keeping this in one file (instead of copy-pasting into both pages) is deliberate: this app
// already learned the hard way (see asset-dashboard) that two hand-synced copies of the same
// logic drift apart. Page-specific code (which columns to show, page layout) stays in each HTML file.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, setDoc, updateDoc, deleteField, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export const STORAGE_KEY = "ops-board-v1";
export const SYNC_CODE_KEY = "ops-board-sync-code";

export const STATUSES = [
  { id: "todo", label: "해야 할 일" },
  { id: "doing", label: "진행중인 일" },
  { id: "done", label: "완료된 일" }
];

export const DEFAULT_CATEGORIES = [
  { id: "cat-buy", label: "구매·발주", color: "#b5714a" },
  { id: "cat-approve", label: "결재·승인", color: "#5b7185" },
  { id: "cat-asset", label: "장비·자산", color: "#6b7f4f" },
  { id: "cat-admin", label: "사내행정", color: "#7a5c74" },
  { id: "cat-etc", label: "기타", color: "#8c8676" }
];

// Fixed 3-person roster (총무팀). Not user-editable from the UI on purpose - keeps the
// per-person tab list stable and short. Update here if the team roster changes.
export const ASSIGNEES = [
  { id: "simba", label: "심바", color: "#5b7185" },
  { id: "sion", label: "시온", color: "#b0793a" },
  { id: "dante", label: "단테", color: "#4f7d6b" }
];

export const ICONS = {
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  sliders: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="14" cy="6" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="8" cy="12" r="2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="16" cy="18" r="2"/>',
  archive: '<path d="M3 4h18v4H3z"/><path d="M4 8v12h16V8"/><path d="M10 12h4"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'
};

export function icon(name, size) {
  size = size || 14;
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + "</svg>";
}

export function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

export function todayISO() {
  var d = new Date();
  var local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function formatDate(iso) {
  if (!iso) return "";
  var d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", weekday: "short" }).format(d);
}

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// ---------- state ----------

function loadState() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.categories)) return parsed;
    }
  } catch (e) {}
  return { categories: DEFAULT_CATEGORIES.slice(), tasks: [] };
}

export var state = loadState();
export var activeFilters = new Set();

// ---------- per-device identity + assignee tab ----------
// "Which of the 3 people is this browser/device?" - stored locally so the board defaults to
// that person's own tab. Not an auth system; anyone can switch it, it's just a convenience so
// each of the 3 lands on their own view instead of the shared "전체 보기" every time.

var MY_ASSIGNEE_KEY = "ops-board-my-assignee";

export function assigneeById(id) {
  return ASSIGNEES.find(function (a) { return a.id === id; }) || null;
}

export function getMyAssignee() {
  return localStorage.getItem(MY_ASSIGNEE_KEY);
}

export function setMyAssignee(id) {
  localStorage.setItem(MY_ASSIGNEE_KEY, id);
}

export var activeAssigneeTab = "all"; // "all" | assignee id

export function initAssigneeTab() {
  activeAssigneeTab = getMyAssignee() || "all";
}

var draggedId = null;
var draggedSubtask = null; // { taskId, subtaskId }
var editingSubtask = null; // { taskId, subtaskId }
var pendingDeleteId = null;
var pendingDeleteTimer = null;
var openForm = null; // { mode: 'add', status } | { mode: 'edit', id }
var pendingRemote = null;

var onRenderNeeded = function () {};
export function setRenderCallback(fn) { onRenderNeeded = fn; }

var onSyncStatusChange = function () {};
export function setSyncStatusCallback(fn) { onSyncStatusChange = fn; }

var onStatusMessage = function () {};
export function setStatusMessageCallback(fn) { onStatusMessage = fn; }

function notifyRender() { onRenderNeeded(); }
function setSyncStatus(text, cls) { onSyncStatusChange(text, cls); }
export function showStatus(msg) { onStatusMessage(msg); }

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  queueCloudPush();
  notifyRender();
}

// ---------- cloud sync ----------

var firebaseConfig = {
  apiKey: "AIzaSyBBvLZknkFUSvbtTyNdxFJInEBb2a8kWs0",
  authDomain: "chmin-board.firebaseapp.com",
  projectId: "chmin-board",
  storageBucket: "chmin-board.firebasestorage.app",
  messagingSenderId: "70193210378",
  appId: "1:70193210378:web:eb7fcd3c44a59b75b56bf3"
};
var fbApp = initializeApp(firebaseConfig);
var db = getFirestore(fbApp);

function genSyncCode() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return (Date.now().toString(16) + Math.random().toString(16).slice(2)).slice(0, 16);
}

// If this page was opened via an invite link (?code=...), that code wins over whatever this
// browser already had - pasting a bare code by hand is where the 3-person rollout actually went
// wrong (easy to mistype or partially copy), so a clickable link is the reliable path now.
function codeFromUrl() {
  try {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    if (!code) return null;
    var url = new URL(window.location.href);
    url.searchParams.delete("code");
    window.history.replaceState(null, "", url.toString());
    return code;
  } catch (e) {
    return null;
  }
}

export var syncCode = codeFromUrl() || localStorage.getItem(SYNC_CODE_KEY) || genSyncCode();
localStorage.setItem(SYNC_CODE_KEY, syncCode);

var unsubscribeSync = null;
var cloudSyncTimer = null;

function queueCloudPush() {
  setSyncStatus("동기화 중…", "pending");
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(pushToCloud, 500);
}

// Cloud writes are per-task field patches, not a "whole tasks array" overwrite. The old
// approach (setDoc of the entire tasks array on every change) meant two people editing
// *different* tasks around the same time could stomp each other: whoever's debounced push
// landed second would silently resurrect whatever stale copy of *every other task* their
// browser last had in memory - e.g. a teammate's just-deleted note reappearing because someone
// else's unrelated save re-sent their outdated version of that same task. Tracking exactly
// which task ids changed and writing only those (via Firestore's dot-path field updates) means
// concurrent edits to different tasks can never clobber each other. Editing the *same* task at
// the exact same moment can still race, but that's a much narrower, expected kind of conflict.
var dirtyTaskIds = new Set();
var deletedTaskIds = new Set();
var categoriesDirty = false;

function markTaskDirty(id) { dirtyTaskIds.add(id); deletedTaskIds.delete(id); }
function markTaskDeleted(id) { deletedTaskIds.add(id); dirtyTaskIds.delete(id); }
function markCategoriesDirty() { categoriesDirty = true; }

function tasksArrayToMap(arr) {
  var m = {};
  arr.forEach(function (t) { m[t.id] = t; });
  return m;
}

function pushToCloud() {
  var ref = doc(db, "boards", syncCode);
  var dirty = dirtyTaskIds;
  var deleted = deletedTaskIds;
  var catsDirty = categoriesDirty;
  dirtyTaskIds = new Set();
  deletedTaskIds = new Set();
  categoriesDirty = false;

  var patch = { savedAt: Date.now() };
  if (catsDirty) patch.categories = state.categories;
  dirty.forEach(function (id) {
    var t = state.tasks.find(function (x) { return x.id === id; });
    if (t) patch["tasks." + id] = t;
  });
  deleted.forEach(function (id) { patch["tasks." + id] = deleteField(); });

  updateDoc(ref, patch)
    .then(function () {
      setSyncStatus("동기화됨 · " + new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }), "ok");
    })
    .catch(function (err) {
      // Brand new board (doc doesn't exist yet) - seed it with everything currently local.
      if (err && err.code === "not-found") {
        setDoc(ref, { categories: state.categories, tasks: tasksArrayToMap(state.tasks), savedAt: Date.now() })
          .then(function () {
            setSyncStatus("동기화됨 · " + new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }), "ok");
          })
          .catch(function () { setSyncStatus("동기화 실패 (오프라인?)", "err"); });
        return;
      }
      // Put the markers back so the next push retries this same patch.
      dirty.forEach(function (id) { dirtyTaskIds.add(id); });
      deleted.forEach(function (id) { deletedTaskIds.add(id); });
      if (catsDirty) categoriesDirty = true;
      setSyncStatus("동기화 실패 (오프라인?)", "err");
    });
}

// One-off: a board still holding the old "tasks as a whole array" shape gets rewritten as a
// map the first time any client with this code reads it, so future per-task patches apply
// cleanly (Firestore's dot-path updates need `tasks` to already be a map, not an array).
function migrateLegacyArrayShape() {
  var ref = doc(db, "boards", syncCode);
  setDoc(ref, { categories: state.categories, tasks: tasksArrayToMap(state.tasks), savedAt: Date.now() }).catch(function () {});
}

// A remote update is allowed through mid-typing in the one place that isn't guarded by
// openForm/editingSubtask: the "+ 하위 항목 추가" quick-add box (committing it doesn't open a
// tracked editing mode, it's just a bare input). A full re-render would otherwise destroy that
// input - along with whatever was typed but not yet submitted - out from under the typist.
// Capture it before re-rendering and restore it after, on the same task's card if still present.
function captureTypingInProgress() {
  var el = document.activeElement;
  if (!el || !el.matches || !el.matches("[data-subtask-new]")) return null;
  var card = el.closest(".card");
  if (!card) return null;
  return { cardId: card.dataset.cardId, value: el.value, selStart: el.selectionStart, selEnd: el.selectionEnd };
}

function restoreTypingInProgress(captured) {
  if (!captured) return;
  var el = document.querySelector('.card[data-card-id="' + captured.cardId + '"] [data-subtask-new]');
  if (!el) return;
  el.value = captured.value;
  el.focus();
  try { el.setSelectionRange(captured.selStart, captured.selEnd); } catch (e) {}
}

function applyRemoteState(data) {
  var typing = captureTypingInProgress();

  state.categories = categoriesDirty
    ? state.categories
    : (Array.isArray(data.categories) && data.categories.length ? data.categories : DEFAULT_CATEGORIES.slice());

  var incomingTasks;
  if (Array.isArray(data.tasks)) {
    incomingTasks = data.tasks;
  } else if (data.tasks && typeof data.tasks === "object") {
    incomingTasks = Object.keys(data.tasks).map(function (id) {
      var t = data.tasks[id];
      if (!t.id) t.id = id;
      return t;
    });
  } else {
    incomingTasks = [];
  }

  // Don't let an incoming snapshot clobber a local change that hasn't been pushed to the
  // server yet: for any task we know is dirty/deleted locally, keep our in-memory version (it
  // will win once our own debounced push lands); every other task takes the fresh remote value.
  // Without this, a snapshot landing in the narrow window between "user made an edit" and "that
  // edit's 500ms-debounced push completed" would silently revert the edit right back out.
  var localById = {};
  state.tasks.forEach(function (t) { localById[t.id] = t; });
  var merged = incomingTasks
    .filter(function (t) { return !deletedTaskIds.has(t.id); })
    .map(function (t) { return (dirtyTaskIds.has(t.id) && localById[t.id]) ? localById[t.id] : t; });
  state.tasks.forEach(function (t) {
    if (dirtyTaskIds.has(t.id) && !merged.some(function (m) { return m.id === t.id; })) merged.push(t);
  });
  state.tasks = merged;

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  activeFilters.forEach(function (id) {
    if (!state.categories.some(function (c) { return c.id === id; })) activeFilters.delete(id);
  });
  notifyRender();
  restoreTypingInProgress(typing);
}

export function subscribeSync() {
  if (unsubscribeSync) unsubscribeSync();
  setSyncStatus("연결 중…", "pending");
  var ref = doc(db, "boards", syncCode);
  unsubscribeSync = onSnapshot(ref, function (snap) {
    if (!snap.exists()) {
      setSyncStatus("동기화 대기 (새 코드)", "ok");
      return;
    }
    var data = snap.data();
    if (openForm || editingSubtask) {
      pendingRemote = data;
      return;
    }
    applyRemoteState(data);
    if (Array.isArray(data.tasks) && data.tasks.length) migrateLegacyArrayShape();
    setSyncStatus("동기화됨 · " + new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }), "ok");
  }, function () {
    setSyncStatus("동기화 연결 실패", "err");
  });
}

export function repairSync(code) {
  code = code.trim();
  if (!code || code === syncCode) return;
  syncCode = code;
  localStorage.setItem(SYNC_CODE_KEY, syncCode);
  subscribeSync();
}

// ---------- queries ----------

export function categoryById(id) {
  return state.categories.find(function (c) { return c.id === id; }) || null;
}

export function tasksFor(status) {
  var list = state.tasks.filter(function (t) { return t.status === status; });
  if (status === "done") {
    list.sort(function (a, b) {
      var av = a.date || new Date(a.updatedAt).toISOString().slice(0, 10);
      var bv = b.date || new Date(b.updatedAt).toISOString().slice(0, 10);
      if (av === bv) return b.updatedAt - a.updatedAt;
      return av < bv ? 1 : -1;
    });
  } else {
    list.sort(function (a, b) { return a.order - b.order; });
  }
  return list;
}

export function visibleTasksFor(status, extraFilterFn) {
  var list = tasksFor(status);
  // Tasks created before assignees existed (or never assigned) have no `assignee` - keep them
  // visible on every person's tab rather than hiding them anywhere but 전체 보기, so old data
  // never silently disappears. They show a "미지정" badge (see cardHtml) as a nudge to assign.
  if (activeAssigneeTab !== "all") list = list.filter(function (t) { return !t.assignee || t.assignee === activeAssigneeTab; });
  if (activeFilters.size > 0) list = list.filter(function (t) { return activeFilters.has(t.category); });
  if (extraFilterFn) list = list.filter(extraFilterFn);
  return list;
}

// All tasks that have a date set, across every status (todo/doing/done) - for the calendar
// view, which cares about "when" rather than "what column". Same assignee/category filter
// rules as visibleTasksFor.
export function visibleDatedTasks() {
  return state.tasks.filter(function (t) {
    if (!t.date) return false;
    if (activeAssigneeTab !== "all" && t.assignee && t.assignee !== activeAssigneeTab) return false;
    if (activeFilters.size > 0 && !activeFilters.has(t.category)) return false;
    return true;
  });
}

// ---------- mutations (all persist + trigger re-render) ----------

export function addTask(status, fields) {
  var minOrder = state.tasks.filter(function (t) { return t.status === status; })
    .reduce(function (m, t) { return Math.min(m, t.order); }, Date.now());
  var id = uid();
  state.tasks.push({
    id: id,
    title: fields.title,
    category: fields.category,
    assignee: fields.assignee || getMyAssignee() || ASSIGNEES[0].id,
    date: fields.date || "",
    notes: fields.notes || "",
    status: status,
    order: minOrder - 1,
    subtasks: [],
    updatedAt: Date.now()
  });
  markTaskDirty(id);
  persist();
}

export function updateTask(id, fields) {
  var t = state.tasks.find(function (x) { return x.id === id; });
  if (!t) return;
  t.title = fields.title;
  t.category = fields.category;
  t.assignee = fields.assignee || t.assignee;
  t.date = fields.date || "";
  t.notes = fields.notes || "";
  t.updatedAt = Date.now();
  markTaskDirty(id);
  persist();
}

export function deleteTask(id) {
  state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
  markTaskDeleted(id);
  persist();
}

export function ensureSubtasks(t) {
  if (!Array.isArray(t.subtasks)) t.subtasks = [];
  return t.subtasks;
}

export function addSubtask(taskId, text) {
  text = text.trim();
  if (!text) return;
  var t = state.tasks.find(function (x) { return x.id === taskId; });
  if (!t) return;
  ensureSubtasks(t).push({ id: uid(), text: text, done: false });
  t.updatedAt = Date.now();
  markTaskDirty(taskId);
  persist();
}

export function toggleSubtask(taskId, subtaskId) {
  var t = state.tasks.find(function (x) { return x.id === taskId; });
  if (!t) return;
  var s = ensureSubtasks(t).find(function (x) { return x.id === subtaskId; });
  if (!s) return;
  s.done = !s.done;
  t.updatedAt = Date.now();
  markTaskDirty(taskId);
  persist();
}

export function deleteSubtask(taskId, subtaskId) {
  var t = state.tasks.find(function (x) { return x.id === taskId; });
  if (!t) return;
  t.subtasks = ensureSubtasks(t).filter(function (x) { return x.id !== subtaskId; });
  t.updatedAt = Date.now();
  markTaskDirty(taskId);
  persist();
}

export function updateSubtaskText(taskId, subtaskId, text) {
  var t = state.tasks.find(function (x) { return x.id === taskId; });
  if (!t) return;
  var s = ensureSubtasks(t).find(function (x) { return x.id === subtaskId; });
  if (!s) return;
  s.text = text;
  t.updatedAt = Date.now();
  markTaskDirty(taskId);
  persist();
}

export function reorderSubtask(taskId, subtaskId, dropIndex) {
  var t = state.tasks.find(function (x) { return x.id === taskId; });
  if (!t) return;
  var list = ensureSubtasks(t);
  var idx = list.findIndex(function (s) { return s.id === subtaskId; });
  if (idx === -1) return;
  var item = list.splice(idx, 1)[0];
  list.splice(dropIndex, 0, item);
  t.updatedAt = Date.now();
  markTaskDirty(taskId);
  persist();
}

export function moveTask(id, dir) {
  var t = state.tasks.find(function (x) { return x.id === id; });
  if (!t) return;
  var idx = STATUSES.findIndex(function (s) { return s.id === t.status; });
  var next = idx + dir;
  if (next < 0 || next >= STATUSES.length) return;
  var newStatus = STATUSES[next].id;
  var targetOrders = state.tasks.filter(function (x) { return x.status === newStatus; }).map(function (x) { return x.order; });
  t.order = (targetOrders.length ? Math.min.apply(null, targetOrders) : Date.now()) - 1;
  t.status = newStatus;
  if (newStatus === "done") t.updatedAt = Date.now();
  markTaskDirty(id);
  persist();
}

export function dropTask(id, status, dropIndex) {
  var t = state.tasks.find(function (x) { return x.id === id; });
  if (!t) return;
  var siblings = state.tasks.filter(function (x) { return x.status === status && x.id !== id; })
    .sort(function (a, b) { return a.order - b.order; });
  var before = siblings[dropIndex - 1];
  var after = siblings[dropIndex];
  var newOrder;
  if (before && after) newOrder = (before.order + after.order) / 2;
  else if (before) newOrder = before.order + 1;
  else if (after) newOrder = after.order - 1;
  else newOrder = Date.now();
  t.order = newOrder;
  var statusChanged = t.status !== status;
  t.status = status;
  if (statusChanged && status === "done") t.updatedAt = Date.now();
  markTaskDirty(id);
  persist();
}

export function addCategory(label, color) {
  label = label.trim();
  if (!label) return;
  state.categories.push({ id: "cat-" + uid(), label: label, color: color });
  markCategoriesDirty();
  persist();
}

export function updateCategory(id, fields) {
  var c = categoryById(id);
  if (!c) return;
  if (fields.label !== undefined) c.label = fields.label;
  if (fields.color !== undefined) c.color = fields.color;
  markCategoriesDirty();
  persist();
}

export function deleteCategory(id) {
  if (state.categories.length <= 1) return;
  state.categories = state.categories.filter(function (c) { return c.id !== id; });
  var fallback = state.categories[0].id;
  state.tasks.forEach(function (t) { if (t.category === id) { t.category = fallback; markTaskDirty(t.id); } });
  markCategoriesDirty();
  persist();
}

// One-off cleanup for tasks that predate the assignee feature (or were never assigned).
// Only touches status === "done" tasks with no assignee - deliberately scoped, not a
// general "assign everything to me" tool.
export function bulkAssignUnassignedDone(id) {
  var count = 0;
  state.tasks.forEach(function (t) {
    if (t.status === "done" && !t.assignee) {
      t.assignee = id;
      t.updatedAt = Date.now();
      markTaskDirty(t.id);
      count++;
    }
  });
  if (count > 0) persist();
  return count;
}

// Explicit "restore from backup" - unlike routine edits, this really does mean "replace
// everything with what's in the file", so every task gets marked dirty (and old cloud tasks
// that aren't in the import stay deleted via a plain setDoc, not a patch).
export function importState(parsed) {
  if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.categories)) return false;
  state.categories = parsed.categories;
  state.tasks = parsed.tasks;
  activeFilters.clear();
  var ref = doc(db, "boards", syncCode);
  dirtyTaskIds.clear();
  deletedTaskIds.clear();
  categoriesDirty = false;
  setSyncStatus("동기화 중…", "pending");
  setDoc(ref, { categories: state.categories, tasks: tasksArrayToMap(state.tasks), savedAt: Date.now() })
    .then(function () { setSyncStatus("동기화됨 · " + new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }), "ok"); })
    .catch(function () { setSyncStatus("동기화 실패 (오프라인?)", "err"); });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  notifyRender();
  return true;
}

// ---------- shared HTML fragments ----------

export function categoryOptions(selectedId) {
  return state.categories.map(function (c) {
    return '<option value="' + c.id + '"' + (c.id === selectedId ? " selected" : "") + ">" + escapeHtml(c.label) + "</option>";
  }).join("");
}

export function assigneeOptions(selectedId) {
  return ASSIGNEES.map(function (a) {
    return '<option value="' + a.id + '"' + (a.id === selectedId ? " selected" : "") + ">" + escapeHtml(a.label) + "</option>";
  }).join("");
}

function defaultAssignee() {
  if (activeAssigneeTab !== "all") return activeAssigneeTab;
  return getMyAssignee() || ASSIGNEES[0].id;
}

export function formHtml(task, status) {
  var isEdit = !!task;
  var prefillDate = (!isEdit && openForm && openForm.mode === "add" && openForm.date) || "";
  var t = task || { title: "", category: state.categories[0].id, assignee: defaultAssignee(), date: prefillDate, notes: "" };
  return '<div class="form" data-form="' + (isEdit ? "edit" : "add") + '" data-target="' + (isEdit ? task.id : status) + '">' +
    '<input type="text" data-f-title placeholder="업무 내용" maxlength="120" value="' + escapeHtml(t.title) + '" />' +
    '<div class="form-row">' +
    '<select data-f-category>' + categoryOptions(t.category) + "</select>" +
    '<select data-f-assignee>' + assigneeOptions(t.assignee) + "</select>" +
    "</div>" +
    '<div class="form-row">' +
    '<input type="date" data-f-date value="' + (t.date || "") + '" />' +
    "</div>" +
    '<textarea data-f-notes placeholder="비고 (선택)" maxlength="400">' + escapeHtml(t.notes) + "</textarea>" +
    '<div class="form-actions">' +
    '<button type="button" class="todaybtn" data-set-today>오늘 날짜</button>' +
    '<div class="btnrow">' +
    (isEdit ? '<button type="button" class="del-link" data-form-delete>삭제</button>' : "") +
    '<button type="button" class="cancel-btn" data-form-cancel>취소</button>' +
    '<button type="button" class="save-btn" data-form-save>저장</button>' +
    "</div></div></div>";
}

// moveHtml: idx 0 (todo) -> forward only; idx 1 (doing) -> back + explicit "완료" button;
// idx 2 (done, history page) -> "되돌리기" only. This replaces drag-to-done now that the
// done column isn't part of the main board.
function moveButtonsHtml(idx) {
  if (idx === 0) {
    return '<button type="button" data-move="1" title="진행중으로 이동">' + icon("right") + "</button>";
  }
  if (idx === 1) {
    return '<button type="button" data-move="-1" title="이전 단계로">' + icon("left") + "</button>" +
      '<button type="button" class="donebtn" data-move="1" title="완료 처리">' + icon("check", 13) + " 완료</button>";
  }
  return '<button type="button" class="restorebtn" data-move="-1" title="진행중으로 되돌리기">' + icon("left", 13) + " 되돌리기</button>";
}

export function cardHtml(t, opts) {
  opts = opts || {};
  var draggableHandle = opts.draggableHandle !== false;
  var cat = categoryById(t.category);
  var assignee = assigneeById(t.assignee);
  var overdue = t.date && t.status !== "done" && t.date < todayISO();
  var idx = STATUSES.findIndex(function (s) { return s.id === t.status; });
  var delConfirm = pendingDeleteId === t.id;
  var catStyle = cat ? ' style="--cat-color:' + cat.color + "; --cat-color-soft: color-mix(in srgb, " + cat.color + ' 16%, var(--surface));"' : "";
  var subtasks = Array.isArray(t.subtasks) ? t.subtasks : [];
  var doneCount = subtasks.filter(function (s) { return s.done; }).length;
  var subtaskProgress = subtasks.length
    ? '<div class="subtask-progress mono"><span>' + doneCount + "/" + subtasks.length + '</span><span class="subtask-bar"><span style="width:' + Math.round(doneCount / subtasks.length * 100) + '%"></span></span></div>'
    : "";
  var subtaskRows = subtasks.map(function (s) {
    var isEditing = editingSubtask && editingSubtask.taskId === t.id && editingSubtask.subtaskId === s.id;
    var textPart = isEditing
      ? '<input type="text" class="stext-edit" data-subtask-edit-input maxlength="200" value="' + escapeHtml(s.text) + '" />'
      : '<span class="stext" data-subtask-edit>' + escapeHtml(s.text) + "</span>";
    return '<div class="subtask-row' + (s.done ? " done" : "") + '" data-subtask-id="' + s.id + '">' +
      '<span class="sgrip" draggable="true" title="순서 변경">' + icon("grip", 14) + "</span>" +
      '<input type="checkbox" data-subtask-toggle' + (s.done ? " checked" : "") + ' aria-label="하위 항목 완료" />' +
      textPart +
      '<button type="button" class="sdel" data-subtask-delete title="하위 항목 삭제">' + icon("x", 12) + "</button>" +
      "</div>";
  }).join("");
  var subtaskAdd = '<div class="subtask-add"><input type="text" data-subtask-new placeholder="+ 하위 항목 추가" maxlength="200" />' +
    '<button type="button" data-subtask-add title="하위 항목 추가">' + icon("plus", 13) + "</button></div>";
  return '<div class="card" data-card-id="' + t.id + '"' + catStyle + ">" +
    '<div class="card-handle"' + (draggableHandle ? ' draggable="true" title="잡아서 이동"' : "") + '>' +
    '<div class="row1">' +
    '<div class="row1-left">' +
    (assignee
      ? '<span class="assignee-badge" style="background:' + assignee.color + '" title="' + escapeHtml(assignee.label) + '">' + escapeHtml(assignee.label[0]) + "</span>"
      : '<span class="assignee-badge unassigned" title="담당자 미지정 - 수정에서 지정해주세요">?</span>') +
    '<span class="cat-tag">' + (cat ? '<span class="dot" style="background:' + cat.color + '"></span><span>' + escapeHtml(cat.label) + "</span>" : "") + "</span>" +
    "</div>" +
    (t.date ? '<span class="date-badge mono' + (overdue ? " overdue" : "") + '">' + formatDate(t.date) + "</span>" : "") +
    "</div>" +
    '<div class="title" data-open-edit>' + escapeHtml(t.title) + "</div>" +
    "</div>" +
    (t.notes ? '<div class="notes" data-open-edit>' + escapeHtml(t.notes) + "</div>" : "") +
    subtaskProgress +
    '<div class="subtasks">' + subtaskRows + "</div>" +
    subtaskAdd +
    '<div class="actions">' +
    '<div class="movegroup">' + moveButtonsHtml(idx) + "</div>" +
    '<div class="movegroup">' +
    '<button type="button" class="metabtn edit" data-open-edit title="수정">' + icon("pencil") + "</button>" +
    '<button type="button" class="metabtn del' + (delConfirm ? " confirm" : "") + '" data-delete title="삭제">' + (delConfirm ? "" : icon("trash")) + "</button>" +
    "</div></div></div>";
}

export function cardOrFormHtml(t, opts) {
  if (openForm && openForm.mode === "edit" && openForm.id === t.id) return formHtml(t, null);
  return cardHtml(t, opts);
}

export function isAddOpenFor(status) {
  return !!(openForm && openForm.mode === "add" && openForm.status === status);
}

// ---------- shared interaction wiring ----------
// Attaches every card/subtask/form interaction (open edit, move, delete, subtask
// add/toggle/edit/delete/reorder, card drag-and-drop) to rootEl via event delegation.
// Card-level drag only does anything on pages that render `.column` wrappers (index.html);
// on history.html it's simply a no-op since there's nowhere to drop onto.

export function wireCardEvents(rootEl) {
  function focusFirstInput() {
    var el = rootEl.querySelector(".form [data-f-title]");
    if (el) el.focus();
  }
  function focusSubtaskInput(cardId) {
    var el = rootEl.querySelector('.card[data-card-id="' + cardId + '"] [data-subtask-new]');
    if (el) el.focus();
  }
  function focusEditingSubtask() {
    var el = rootEl.querySelector("[data-subtask-edit-input]");
    if (el) { el.focus(); el.select(); }
  }
  // Call once whatever the user was mid-doing (form open, subtask text edit) has ended.
  // A remote snapshot that arrived and was deferred (see subscribeSync's guard) while they
  // were busy is discarded rather than applied here: it predates whatever they just committed
  // locally, and applying it now would silently revert their own save. Our own change is
  // already queued to push (queueCloudPush), which will supersede it; the live listener keeps
  // running, so any *later* remote change still comes through normally.
  function afterInteractionEnds() {
    pendingRemote = null;
    notifyRender();
  }
  function closeForms() {
    openForm = null;
    afterInteractionEnds();
  }
  function readForm(formEl) {
    return {
      title: formEl.querySelector("[data-f-title]").value.trim(),
      category: formEl.querySelector("[data-f-category]").value,
      assignee: formEl.querySelector("[data-f-assignee]").value,
      date: formEl.querySelector("[data-f-date]").value,
      notes: formEl.querySelector("[data-f-notes]").value.trim()
    };
  }
  function commitSubtaskEdit(input) {
    if (!editingSubtask) return;
    var text = input.value.trim();
    var target = editingSubtask;
    editingSubtask = null;
    if (text) updateSubtaskText(target.taskId, target.subtaskId, text);
    afterInteractionEnds();
  }
  function cancelSubtaskEdit() {
    editingSubtask = null;
    afterInteractionEnds();
  }

  rootEl.addEventListener("click", function (e) {
    var addBtn = e.target.closest("[data-open-add]");
    if (addBtn) {
      var col = addBtn.closest(".column");
      var status = addBtn.dataset.openAddStatus || (col ? col.dataset.status : "todo");
      openForm = { mode: "add", status: status };
      if (addBtn.dataset.openAddDate) openForm.date = addBtn.dataset.openAddDate;
      notifyRender();
      focusFirstInput();
      return;
    }

    var editTrigger = e.target.closest("[data-open-edit]");
    if (editTrigger) {
      var cardEl = editTrigger.closest(".card");
      openForm = { mode: "edit", id: cardEl.dataset.cardId };
      notifyRender();
      focusFirstInput();
      return;
    }

    var moveBtn = e.target.closest("[data-move]");
    if (moveBtn) {
      var cid = moveBtn.closest(".card").dataset.cardId;
      moveTask(cid, parseInt(moveBtn.dataset.move, 10));
      return;
    }

    var delBtn = e.target.closest("[data-delete]");
    if (delBtn) {
      var did = delBtn.closest(".card").dataset.cardId;
      if (pendingDeleteId === did) {
        clearTimeout(pendingDeleteTimer);
        pendingDeleteId = null;
        deleteTask(did);
        showStatus("삭제했습니다");
      } else {
        pendingDeleteId = did;
        notifyRender();
        pendingDeleteTimer = setTimeout(function () { pendingDeleteId = null; notifyRender(); }, 3000);
      }
      return;
    }

    var cancelBtn = e.target.closest("[data-form-cancel]");
    if (cancelBtn) { closeForms(); return; }

    var saveBtn = e.target.closest("[data-form-save]");
    if (saveBtn) {
      var formEl = saveBtn.closest(".form");
      var fields = readForm(formEl);
      if (!fields.title) { formEl.querySelector("[data-f-title]").focus(); return; }
      if (formEl.dataset.form === "add") addTask(formEl.dataset.target, fields);
      else updateTask(formEl.dataset.target, fields);
      closeForms();
      return;
    }

    var formDelBtn = e.target.closest("[data-form-delete]");
    if (formDelBtn) {
      var fid = formDelBtn.closest(".form").dataset.target;
      deleteTask(fid);
      closeForms();
      return;
    }

    var todayBtn = e.target.closest("[data-set-today]");
    if (todayBtn) {
      todayBtn.closest(".form").querySelector("[data-f-date]").value = todayISO();
      return;
    }

    var subAddBtn = e.target.closest("[data-subtask-add]");
    if (subAddBtn) {
      var addCardId = subAddBtn.closest(".card").dataset.cardId;
      var addInput = subAddBtn.closest(".subtask-add").querySelector("[data-subtask-new]");
      addSubtask(addCardId, addInput.value);
      focusSubtaskInput(addCardId);
      return;
    }

    var subDelBtn = e.target.closest("[data-subtask-delete]");
    if (subDelBtn) {
      var delCardId = subDelBtn.closest(".card").dataset.cardId;
      var delSubId = subDelBtn.closest("[data-subtask-id]").dataset.subtaskId;
      deleteSubtask(delCardId, delSubId);
      return;
    }

    var subEditTrigger = e.target.closest("[data-subtask-edit]");
    if (subEditTrigger) {
      var editCardId = subEditTrigger.closest(".card").dataset.cardId;
      var editSubId = subEditTrigger.closest("[data-subtask-id]").dataset.subtaskId;
      editingSubtask = { taskId: editCardId, subtaskId: editSubId };
      notifyRender();
      focusEditingSubtask();
      return;
    }
  });

  rootEl.addEventListener("change", function (e) {
    var chk = e.target.closest("[data-subtask-toggle]");
    if (!chk) return;
    var cardId = chk.closest(".card").dataset.cardId;
    var subId = chk.closest("[data-subtask-id]").dataset.subtaskId;
    toggleSubtask(cardId, subId);
  });

  rootEl.addEventListener("focusout", function (e) {
    var input = e.target.closest("[data-subtask-edit-input]");
    if (input) commitSubtaskEdit(input);
  });

  rootEl.addEventListener("keydown", function (e) {
    var editInput = e.target.closest("[data-subtask-edit-input]");
    if (editInput) {
      if (e.key === "Enter") { e.preventDefault(); editInput.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelSubtaskEdit(); }
      return;
    }
    if (e.key !== "Enter") return;
    var input = e.target.closest("[data-subtask-new]");
    if (!input) return;
    e.preventDefault();
    var cardId = input.closest(".card").dataset.cardId;
    addSubtask(cardId, input.value);
    focusSubtaskInput(cardId);
  });

  // drag and drop: subtask reordering (works on any page), card column-drop (index.html only)
  rootEl.addEventListener("dragstart", function (e) {
    var grip = e.target.closest(".sgrip");
    if (grip) {
      var subRow = grip.closest(".subtask-row");
      var subOwnerCard = grip.closest(".card");
      draggedSubtask = { taskId: subOwnerCard.dataset.cardId, subtaskId: subRow.dataset.subtaskId };
      subRow.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", "s:" + draggedSubtask.subtaskId); } catch (err) {}
      return;
    }
    var handle = e.target.closest(".card-handle[draggable='true']");
    if (!handle) return;
    var card = handle.closest(".card");
    draggedId = card.dataset.cardId;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", draggedId); } catch (err) {}
  });

  rootEl.addEventListener("dragend", function (e) {
    var subRow = e.target.closest(".subtask-row");
    if (subRow) subRow.classList.remove("dragging");
    var card = e.target.closest(".card");
    if (card) card.classList.remove("dragging");
    document.querySelectorAll(".column.drag-over").forEach(function (c) { c.classList.remove("drag-over"); });
    document.querySelectorAll(".subtasks.drag-over").forEach(function (c) { c.classList.remove("drag-over"); });
    draggedId = null;
    draggedSubtask = null;
  });

  rootEl.addEventListener("dragover", function (e) {
    if (draggedSubtask) {
      var subList = e.target.closest(".subtasks");
      if (!subList) return;
      var subOwnerCard = subList.closest(".card");
      if (!subOwnerCard || subOwnerCard.dataset.cardId !== draggedSubtask.taskId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      subList.classList.add("drag-over");
      return;
    }
    var col = e.target.closest(".column");
    if (!col || !draggedId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    col.classList.add("drag-over");
  });

  rootEl.addEventListener("dragleave", function (e) {
    if (draggedSubtask) {
      var subList = e.target.closest(".subtasks");
      if (subList && !subList.contains(e.relatedTarget)) subList.classList.remove("drag-over");
      return;
    }
    var col = e.target.closest(".column");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("drag-over");
  });

  rootEl.addEventListener("drop", function (e) {
    if (draggedSubtask) {
      var subList = e.target.closest(".subtasks");
      if (!subList) { draggedSubtask = null; return; }
      var subOwnerCard = subList.closest(".card");
      if (!subOwnerCard || subOwnerCard.dataset.cardId !== draggedSubtask.taskId) { draggedSubtask = null; return; }
      e.preventDefault();
      subList.classList.remove("drag-over");
      var rows = Array.prototype.filter.call(
        subList.querySelectorAll(".subtask-row"),
        function (r) { return r.dataset.subtaskId !== draggedSubtask.subtaskId; }
      );
      var subDropIndex = rows.length;
      for (var j = 0; j < rows.length; j++) {
        var srect = rows[j].getBoundingClientRect();
        if (e.clientY < srect.top + srect.height / 2) { subDropIndex = j; break; }
      }
      reorderSubtask(draggedSubtask.taskId, draggedSubtask.subtaskId, subDropIndex);
      draggedSubtask = null;
      return;
    }
    var col = e.target.closest(".column");
    if (!col || !draggedId) return;
    e.preventDefault();
    col.classList.remove("drag-over");
    var status = col.dataset.status;
    var cardEls = Array.prototype.filter.call(
      col.querySelectorAll(".card"),
      function (c) { return c.dataset.cardId !== draggedId; }
    );
    var dropIndex = cardEls.length;
    for (var i = 0; i < cardEls.length; i++) {
      var rect = cardEls[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { dropIndex = i; break; }
    }
    dropTask(draggedId, status, dropIndex);
    draggedId = null;
  });
}

// ---------- assignee tab bar + identity panel (shared markup on both pages) ----------
// Order: "my" tab first (labeled 내 업무 once identity is set), then teammates, then 전체 보기.

export function tabsHtml() {
  var mine = getMyAssignee();
  var order = mine
    ? [mine].concat(ASSIGNEES.filter(function (a) { return a.id !== mine; }).map(function (a) { return a.id; }))
    : ASSIGNEES.map(function (a) { return a.id; });
  var tabs = order.map(function (id) {
    var a = assigneeById(id);
    var label = mine && id === mine ? "내 업무" : a.label;
    var active = activeAssigneeTab === id;
    return '<button type="button" class="tab' + (active ? " active" : "") + '" data-tab="' + id + '" style="--tab-color:' + a.color + '">' + escapeHtml(label) + "</button>";
  }).join("");
  tabs += '<button type="button" class="tab' + (activeAssigneeTab === "all" ? " active" : "") + '" data-tab="all">전체 보기</button>';
  return tabs;
}

export function wireTabs(tabsEl, rerender) {
  tabsEl.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-tab]");
    if (!btn) return;
    activeAssigneeTab = btn.dataset.tab;
    rerender();
  });
}

export function identityLabelHtml() {
  var mine = getMyAssignee();
  var a = mine ? assigneeById(mine) : null;
  return a ? "나: " + escapeHtml(a.label) + " · 변경" : "이 기기 사용자 설정";
}

export function identityChoicesHtml() {
  var mine = getMyAssignee();
  return ASSIGNEES.map(function (a) {
    return '<button type="button" class="identity-choice" data-set-identity="' + a.id + '" style="--tab-color:' + a.color + '" aria-pressed="' + (a.id === mine) + '">' + escapeHtml(a.label) + "</button>";
  }).join("");
}

export function wireIdentityPanel(panelEl, rerender) {
  panelEl.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-set-identity]");
    if (!btn) return;
    setMyAssignee(btn.dataset.setIdentity);
    activeAssigneeTab = btn.dataset.setIdentity;
    panelEl.hidden = true;
    rerender();
  });
}

export function wireIdentityToggle() {
  var btn = document.getElementById("toggleIdentityPanel");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var panel = document.getElementById("identityPanel");
    if (panel) panel.hidden = !panel.hidden;
  });
}

// ---------- filter chips + category panel (shared markup, index.html includes both,
// history.html includes only the filter row) ----------

export function filterRowHtml(includeManageButton) {
  var chips = '<button type="button" class="chip all" data-filter-all aria-pressed="' + (activeFilters.size === 0) + '">전체</button>';
  chips += state.categories.map(function (c) {
    var pressed = activeFilters.has(c.id);
    return '<button type="button" class="chip" data-filter="' + c.id + '" aria-pressed="' + pressed + '">' +
      '<span class="dot" style="background:' + c.color + '"></span>' + escapeHtml(c.label) + "</button>";
  }).join("");
  if (includeManageButton) {
    chips += '<button type="button" class="iconbtn" id="toggleCatPanel">' + icon("sliders") + " 카테고리 관리</button>";
  }
  return chips;
}

export function categoryPanelListHtml() {
  var canDelete = state.categories.length > 1;
  return state.categories.map(function (c) {
    return '<div class="catrow" data-cat-id="' + c.id + '">' +
      '<input type="color" value="' + c.color + '" data-cat-color />' +
      '<input type="text" value="' + escapeHtml(c.label) + '" maxlength="16" data-cat-label />' +
      '<button type="button" class="trash" data-cat-delete ' + (canDelete ? "" : "disabled") + '>' + icon("trash") + "</button>" +
      "</div>";
  }).join("");
}

export function wireFilterRow(rowEl, rerender) {
  rowEl.addEventListener("click", function (e) {
    if (e.target.closest("[data-filter-all]")) { activeFilters.clear(); rerender(); return; }
    var chip = e.target.closest("[data-filter]");
    if (chip) {
      var id = chip.dataset.filter;
      if (activeFilters.has(id)) activeFilters.delete(id); else activeFilters.add(id);
      rerender();
      return;
    }
    var toggle = e.target.closest("#toggleCatPanel");
    if (toggle) {
      var panel = document.getElementById("catPanel");
      if (panel) panel.hidden = !panel.hidden;
    }
  });
}

export function wireCategoryPanel(panelEl, rerender) {
  panelEl.addEventListener("input", function (e) {
    var row = e.target.closest("[data-cat-id]");
    if (!row) return;
    var id = row.dataset.catId;
    if (e.target.matches("[data-cat-label]")) updateCategory(id, { label: e.target.value });
    if (e.target.matches("[data-cat-color]")) updateCategory(id, { color: e.target.value });
  });
  panelEl.addEventListener("click", function (e) {
    var delBtn = e.target.closest("[data-cat-delete]");
    if (delBtn && !delBtn.disabled) deleteCategory(delBtn.closest("[data-cat-id]").dataset.catId);
  });
  var addBtn = document.getElementById("addCatBtn");
  if (addBtn) {
    addBtn.addEventListener("click", function () {
      var labelEl = document.getElementById("newCatLabel");
      var colorEl = document.getElementById("newCatColor");
      addCategory(labelEl.value, colorEl.value);
      labelEl.value = "";
    });
  }
}

// ---------- backup export/import ----------

function downloadViaAnchor(filename, text, mime) {
  var blob = new Blob([text], { type: mime || "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// ---------- CSV export (for reviewing/organizing in Excel, not for round-tripping back in -
// the JSON backup above is the one "불러오기" understands) ----------

// Excel's CSV-open (not the "Import Text" wizard, just double-clicking the file) always
// auto-guesses each cell's type from its raw text - there's no CSV syntax to opt a column out
// of that. Two guesses go wrong for us: "3/5" reads as a date (March 5), and a value starting
// with = + - or @ reads as the start of a formula, which then fails with #NAME? because it
// isn't actually one. The fix that actually works is to make Excel evaluate a formula on
// purpose: ="literal text" always displays exactly that text, verbatim, immune to both. Only
// values that would otherwise be misread get wrapped - plain text passes through untouched.
function csvField(value, forceText) {
  var s = String(value == null ? "" : value);
  var risky = forceText && s !== "" && (/^[=+\-@]/.test(s) || /^\d{1,4}[/.-]\d{1,2}([/.-]\d{1,4})?$/.test(s));
  var content = risky ? '="' + s.replace(/"/g, '""') + '"' : s;
  if (/[",\n\r]/.test(content)) content = '"' + content.replace(/"/g, '""') + '"';
  return content;
}

function subtaskProgressText(t) {
  var subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  if (!subs.length) return "";
  var done = subs.filter(function (s) { return s.done; }).length;
  return done + "/" + subs.length;
}

function subtaskListText(t) {
  var subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  return subs.map(function (s) { return (s.done ? "완료: " : "미완료: ") + s.text; }).join("\n");
}

export function exportCsv() {
  // [value, forceText] per column - 날짜만 진짜 날짜로 남겨서 엑셀에서 정렬/필터가 되게 둔다.
  var header = ["상태", "담당자", "카테고리", "제목", "날짜", "진행률", "하위 항목", "비고"];
  var rows = [header.map(function (h) { return csvField(h, false); }).join(",")];
  var tasks = [];
  STATUSES.forEach(function (s) {
    visibleTasksFor(s.id).forEach(function (t) { tasks.push(t); });
  });
  tasks.forEach(function (t) {
    var statusInfo = STATUSES.find(function (s) { return s.id === t.status; });
    var a = assigneeById(t.assignee);
    var cat = categoryById(t.category);
    var cells = [
      csvField(statusInfo ? statusInfo.label : t.status, false),
      csvField(a ? a.label : "미지정", true),
      csvField(cat ? cat.label : "", true),
      csvField(t.title, true),
      csvField(t.date || "", false),
      csvField(subtaskProgressText(t), true),
      csvField(subtaskListText(t), true),
      csvField(t.notes || "", true)
    ];
    rows.push(cells.join(","));
  });
  var csv = rows.join("\r\n");
  var filename = "업무보드-" + todayISO() + ".csv";
  try {
    // Leading BOM so Excel (Korean Windows especially) reads this as UTF-8 instead of
    // mangling every non-ASCII character - a very common CSV-from-JS gotcha.
    downloadViaAnchor(filename, "﻿" + csv, "text/csv;charset=utf-8");
    showStatus(tasks.length + "개 업무를 CSV로 내려받았습니다");
  } catch (e) {
    showStatus("CSV 저장에 실패했습니다");
  }
}

export function exportBackup() {
  var data = JSON.stringify(state, null, 2);
  var filename = "ops-board-" + todayISO() + ".json";
  if (window.claude && window.claude.downloads) {
    window.claude.downloads.save({ filename: filename, data: data })
      .then(function () { showStatus("백업 파일을 저장했습니다"); })
      .catch(function (err) {
        if (err && err.code === "declined") return;
        showStatus("저장에 실패했습니다");
      });
  } else {
    try {
      downloadViaAnchor(filename, data);
      showStatus("백업 파일을 저장했습니다");
    } catch (e) {
      showStatus("저장에 실패했습니다");
    }
  }
}

export function importBackupFile(file) {
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var parsed = JSON.parse(reader.result);
      if (!importState(parsed)) throw new Error("bad shape");
      showStatus("가져오기 완료");
    } catch (err) {
      showStatus("올바른 백업 파일이 아닙니다");
    }
  };
  reader.readAsText(file);
}

// ---------- sync panel (shared markup on both pages) ----------

export function inviteLinkUrl() {
  return new URL("index.html?code=" + encodeURIComponent(syncCode), window.location.href).toString();
}

export function wireSyncPanelUI() {
  var display = document.getElementById("syncCodeDisplay");
  if (display) display.textContent = syncCode;
  var toggleBtn = document.getElementById("toggleSyncPanel");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      var panel = document.getElementById("syncPanel");
      if (panel) panel.hidden = !panel.hidden;
    });
  }
  var copyLinkBtn = document.getElementById("copyInviteLink");
  if (copyLinkBtn) {
    copyLinkBtn.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(inviteLinkUrl())
          .then(function () { showStatus("초대 링크를 복사했습니다 - 카톡 등으로 보내주세요"); })
          .catch(function () { showStatus("복사에 실패했습니다"); });
      }
    });
  }
  var copyBtn = document.getElementById("copySyncCode");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(syncCode)
          .then(function () { showStatus("코드를 복사했습니다"); })
          .catch(function () { showStatus("복사에 실패했습니다"); });
      }
    });
  }
  var pairBtn = document.getElementById("pairCodeBtn");
  if (pairBtn) {
    pairBtn.addEventListener("click", function () {
      var input = document.getElementById("pairCodeInput");
      var code = input.value.trim();
      if (!code) return;
      repairSync(code);
      if (display) display.textContent = syncCode;
      input.value = "";
      showStatus("동기화 코드를 연결했습니다");
    });
  }
}

export function wireBackupButtons() {
  var exportBtn = document.getElementById("exportBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportBackup);
  var csvBtn = document.getElementById("exportCsvBtn");
  if (csvBtn) csvBtn.addEventListener("click", exportCsv);
  var importBtn = document.getElementById("importBtn");
  var importFile = document.getElementById("importFile");
  if (importBtn && importFile) {
    importBtn.addEventListener("click", function () { importFile.click(); });
    importFile.addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (file) importBackupFile(file);
      e.target.value = "";
    });
  }
}

export function wireStatusMessage() {
  setStatusMessageCallback(function (msg) {
    var el = document.getElementById("statusMsg");
    if (!el) return;
    el.textContent = msg;
    if (msg) setTimeout(function () { if (el.textContent === msg) el.textContent = ""; }, 3500);
  });
}
