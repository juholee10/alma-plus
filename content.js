const STORAGE_KEY = "almaPlusCustomTasks";
const BACKUP_FORMAT = "alma-plus-task-backup";

let bodyObserver = null;
let debounceTimer = null;
let activeFilter = "all";

async function loadTasks() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

async function saveTasks(tasks) {
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks });
}

async function addTask(task) {
  const tasks = await loadTasks();
  tasks.push({ id: crypto.randomUUID(), completed: false, priority: "normal", ...task });
  await saveTasks(tasks);
}

async function updateTask(updatedTask) {
  const tasks = await loadTasks();
  await saveTasks(tasks.map((task) => task.id === updatedTask.id ? updatedTask : task));
}

async function deleteTask(id) {
  const tasks = await loadTasks();
  await saveTasks(tasks.filter((t) => t.id !== id));
}

async function setTaskCompleted(id, completed) {
  const tasks = await loadTasks();
  await saveTasks(tasks.map((task) => task.id === id ? { ...task, completed } : task));
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
}

function normalizeTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return null;
  if (typeof task.id !== "string" || !task.id.trim()) return null;
  if (typeof task.name !== "string" || !task.name.trim()) return null;
  if (typeof task.due !== "string" || !isValidDate(task.due)) return null;
  if (task.category !== undefined && typeof task.category !== "string") return null;
  if (task.notes !== undefined && typeof task.notes !== "string") return null;
  if (task.completed !== undefined && typeof task.completed !== "boolean") return null;
  if (task.priority !== undefined && !["low", "normal", "high"].includes(task.priority)) return null;
  return {
    id: task.id,
    name: task.name.trim(),
    category: task.category?.trim() || "",
    due: task.due,
    notes: task.notes?.trim() || "",
    completed: task.completed ?? false,
    priority: task.priority || "normal",
  };
}

function findAssignmentsTable() {
  const byClass = document.querySelector("table.upcoming-assignments");
  if (byClass) return byClass;

  const tables = document.querySelectorAll("table");
  for (const table of tables) {
    const headerText = (
      table.querySelector("thead")?.textContent ||
      table.rows[0]?.textContent ||
      ""
    ).toLowerCase();
    if (headerText.includes("due") && headerText.includes("assignment")) {
      return table;
    }
  }
  return null;
}

function getTbody(table) {
  return table.tBodies[0] || table;
}

// alma sorts rows client-side and marks the active th with sort-asc/sort-desc.
// follow that so custom rows land in the right spot when sorted by name.
function getActiveSort(table) {
  const sortableThs = [...table.querySelectorAll("thead th[data-sortable]")];
  const activeIndex = sortableThs.findIndex(
    (th) => th.classList.contains("sort-asc") || th.classList.contains("sort-desc")
  );
  if (activeIndex === -1) {
    return { columnIndex: 0, numeric: true, direction: 1 };
  }
  const th = sortableThs[activeIndex];
  return {
    columnIndex: [...th.parentElement.children].indexOf(th),
    numeric: th.dataset.sortable === "numeric",
    direction: th.classList.contains("sort-desc") ? -1 : 1,
  };
}

function getCellSortValue(row, columnIndex) {
  const cell = row.cells[columnIndex];
  return cell?.getAttribute("data-sortable-val") ?? cell?.textContent.trim() ?? "";
}

function compareSortValues(a, b, numeric) {
  if (numeric) return parseFloat(a) - parseFloat(b);
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

function formatDueLabel(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

// due cells have a unix timestamp in data-sortable-val; the visible text
// ("Sep 17") has no year, so the fallback picks the closest one
function parseAlmaDueCellDate(cell) {
  const ts = parseInt(cell?.getAttribute("data-sortable-val"), 10);
  if (!Number.isNaN(ts)) return new Date(ts * 1000);

  const text = cell?.textContent.trim();
  if (!text) return null;
  const now = new Date();
  const candidates = [-1, 0, 1]
    .map((offset) => new Date(`${text} ${now.getFullYear() + offset}`))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (!candidates.length) return null;
  return candidates.reduce((best, d) =>
    Math.abs(d - now) < Math.abs(best - now) ? d : best
  );
}

// YYYYMMDD in local time
function toCalendarDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function nextDay(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d;
}

// name cell is <strong>Class</strong><br>Assignment name, in alma's rows and ours
function getRowAssignment(row) {
  const [dueCell, nameCell] = row.cells;
  if (!dueCell || !nameCell) return null;

  const due = parseAlmaDueCellDate(dueCell);
  if (!due) return null;

  const titleEl = nameCell.querySelector(".alma-plus-title") || nameCell;
  const category = titleEl.querySelector("strong")?.textContent.trim() || "";
  const fullText = [...titleEl.childNodes]
    .filter((n) => !(n.nodeType === Node.ELEMENT_NODE && n.matches("strong, button, .alma-plus-badge")))
    .map((n) => n.textContent)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const name = fullText || category;
  if (!name) return null;

  const link = nameCell.querySelector("a[href]")?.href || "";
  const custom = row.dataset.almaPlusRow === "true";
  const task = custom ? row._almaPlusTask : null;
  return {
    uid: row.dataset.almaPlusId || `${toCalendarDate(due)}-${category}-${name}`,
    name,
    category,
    due,
    link,
    custom,
    notes: task?.notes || "",
  };
}

function getAllAssignments(table) {
  return [...getTbody(table).rows].map(getRowAssignment).filter(Boolean);
}

function buildEventTitle(a) {
  return a.category ? `${a.name} (${a.category})` : a.name;
}

function buildEventDetails(a) {
  const source = a.custom ? "Personal task added via Alma+" : "Assignment from Alma";
  const details = [source, a.notes, a.link].filter(Boolean);
  return details.join("\n");
}

function buildGoogleCalendarUrl(a) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: buildEventTitle(a),
    dates: `${toCalendarDate(a.due)}/${toCalendarDate(nextDay(a.due))}`,
    details: buildEventDetails(a),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function buildCalendarButton(row) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "alma-plus-cal-btn";
  const icon = document.createElement("img");
  icon.src = chrome.runtime.getURL("google-calendar.svg");
  icon.alt = "";
  icon.width = 18;
  icon.height = 18;
  btn.appendChild(icon);
  btn.title = "Add to Google Calendar";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const assignment = getRowAssignment(row);
    if (assignment) window.open(buildGoogleCalendarUrl(assignment), "_blank", "noopener");
  });
  return btn;
}

function ensureCalendarButtons(tbody) {
  for (const row of tbody.rows) {
    const nameCell = row.cells[1];
    if (!nameCell || nameCell.querySelector(".alma-plus-cal-btn")) continue;
    if (!getRowAssignment(row)) continue;
    nameCell.appendChild(buildCalendarButton(row));
  }
}

function escapeIcsText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// ics lines max out at 75 octets, continuations start with a space
function foldIcsLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const chBytes = new TextEncoder().encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (currentBytes + chBytes > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function buildIcs(assignments) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Alma+//Custom Tasks//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Alma",
  ];
  for (const a of assignments) {
    // stable uid so re-importing updates instead of duplicating
    const uid = `${a.uid}`.replace(/[^\w.-]+/g, "-") + "@alma-plus";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${toCalendarDate(a.due)}`,
      `DTEND;VALUE=DATE:${toCalendarDate(nextDay(a.due))}`,
      `SUMMARY:${escapeIcsText(buildEventTitle(a))}`,
      `DESCRIPTION:${escapeIcsText(buildEventDetails(a))}`,
      ...(a.link ? [`URL:${a.link}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

function exportIcs() {
  const table = findAssignmentsTable();
  if (!table) return;
  const assignments = getAllAssignments(table);
  if (!assignments.length) {
    alert("No assignments found to export.");
    return;
  }

  const blob = new Blob([buildIcs(assignments)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `alma-assignments-${toCalendarDate(new Date())}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildCustomRow(task, columnCount) {
  const row = document.createElement("tr");
  row.dataset.almaPlusRow = "true";
  row.dataset.almaPlusId = task.id;
  const completed = Boolean(task.completed);
  const priorityValue = ["low", "high"].includes(task.priority) ? task.priority : "normal";
  row._almaPlusTask = { ...task, completed, priority: priorityValue };

  const dueDate = new Date(task.due + "T00:00:00");

  const dueCell = document.createElement("td");
  dueCell.className = "alma-plus-due-cell";
  dueCell.dataset.sortableVal = String(Math.floor(dueDate.getTime() / 1000));
  dueCell.textContent = formatDueLabel(dueDate);

  const nameCell = document.createElement("td");
  nameCell.className = "alma-plus-name-cell";
  nameCell.dataset.sortableVal = task.name;

  const badge = document.createElement("span");
  badge.className = "alma-plus-badge";
  badge.textContent = "MINE";

  const title = document.createElement("div");
  title.className = "alma-plus-title";
  if (completed) title.classList.add("alma-plus-completed-title");
  if (task.category) {
    const cat = document.createElement("strong");
    cat.textContent = task.category;
    title.appendChild(cat);
    title.appendChild(document.createElement("br"));
  }
  title.appendChild(document.createTextNode(task.name));

  const metadata = document.createElement("div");
  metadata.className = "alma-plus-metadata";
  if (priorityValue !== "normal") {
    const priority = document.createElement("span");
    priority.className = `alma-plus-priority alma-plus-priority-${priorityValue}`;
    priority.textContent = `${priorityValue} priority`;
    metadata.appendChild(priority);
  }
  if (task.notes) {
    const notes = document.createElement("span");
    notes.className = "alma-plus-notes";
    notes.textContent = task.notes;
    metadata.appendChild(notes);
  }

  const actions = document.createElement("div");
  actions.className = "alma-plus-task-actions";

  const completeLabel = document.createElement("label");
  completeLabel.className = "alma-plus-complete-label";
  completeLabel.addEventListener("click", (e) => e.stopPropagation());
  const completeCheckbox = document.createElement("input");
  completeCheckbox.type = "checkbox";
  completeCheckbox.checked = completed;
  completeCheckbox.setAttribute("aria-label", `Mark ${task.name} ${completed ? "incomplete" : "complete"}`);
  completeCheckbox.addEventListener("change", async (e) => {
    e.stopPropagation();
    await setTaskCompleted(task.id, completeCheckbox.checked);
    renderCustomRows();
  });
  completeLabel.appendChild(completeCheckbox);
  completeLabel.appendChild(document.createTextNode("Done"));
  actions.appendChild(completeLabel);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "alma-plus-edit";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openModal(task);
  });
  actions.appendChild(editBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "alma-plus-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Remove this task";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await deleteTask(task.id);
    renderCustomRows();
  });

  nameCell.appendChild(badge);
  nameCell.appendChild(title);
  nameCell.appendChild(metadata);
  nameCell.appendChild(actions);
  nameCell.appendChild(deleteBtn);
  if (completed) row.classList.add("alma-plus-completed-row");

  row.appendChild(dueCell);
  row.appendChild(nameCell);

  for (let i = 2; i < columnCount; i++) {
    row.appendChild(document.createElement("td"));
  }

  return row;
}

async function renderCustomRows() {
  const table = findAssignmentsTable();
  if (!table) return;
  const tbody = getTbody(table);
  const tasks = await loadTasks();
  const sort = getActiveSort(table);

  bodyObserver?.disconnect();
  try {
    tbody.querySelectorAll("[data-alma-plus-row]").forEach((el) => el.remove());

    const existingRows = [...tbody.querySelectorAll("tr:not([data-alma-plus-row])")];
    const columnCount =
      existingRows[0]?.cells.length ||
      table.querySelector("thead tr")?.cells.length ||
      2;

    for (const task of tasks) {
      const row = buildCustomRow(task, columnCount);
      const rowValue = getCellSortValue(row, sort.columnIndex);

      const target = existingRows.find((r) => {
        const cmp = compareSortValues(rowValue, getCellSortValue(r, sort.columnIndex), sort.numeric);
        return cmp * sort.direction < 0;
      });

      if (target) {
        target.before(row);
      } else {
        tbody.appendChild(row);
      }
    }

    ensureCalendarButtons(tbody);
    applyAssignmentFilter(tbody);
  } finally {
    bodyObserver?.observe(document.body, { childList: true, subtree: true });
  }
}

function buildAddButton() {
  const btn = document.createElement("button");
  btn.id = "alma-plus-add-btn";
  btn.type = "button";
  btn.textContent = "+ Add my own task";
  btn.addEventListener("click", () => openModal());
  return btn;
}

function buildExportButton() {
  const btn = document.createElement("button");
  btn.id = "alma-plus-export-btn";
  btn.type = "button";
  btn.textContent = "Export to calendar (.ics)";
  btn.title = "Download all assignments as a calendar file you can import into Google Calendar";
  btn.addEventListener("click", exportIcs);
  return btn;
}

function buildBackupButton() {
  const btn = document.createElement("button");
  btn.id = "alma-plus-backup-btn";
  btn.type = "button";
  btn.textContent = "Back up tasks";
  btn.title = "Download your custom tasks as a JSON backup";
  btn.addEventListener("click", exportTaskBackup);
  return btn;
}

function buildImportButton() {
  const btn = document.createElement("button");
  btn.id = "alma-plus-import-btn";
  btn.type = "button";
  btn.textContent = "Restore tasks";
  btn.title = "Import custom tasks from a JSON backup";
  btn.addEventListener("click", () => document.getElementById("alma-plus-import-input").click());
  return btn;
}

function buildFilter() {
  const label = document.createElement("label");
  label.id = "alma-plus-filter-label";
  label.textContent = "Show: ";
  const select = document.createElement("select");
  select.id = "alma-plus-filter";
  for (const [value, text] of [
    ["all", "All assignments"],
    ["today", "Due today"],
    ["week", "Due this week"],
    ["overdue", "Overdue"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = activeFilter;
  select.addEventListener("change", () => {
    activeFilter = select.value;
    const table = findAssignmentsTable();
    if (table) applyAssignmentFilter(getTbody(table));
  });
  label.appendChild(select);
  return label;
}

function applyAssignmentFilter(tbody) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  for (const row of tbody.rows) {
    const assignment = getRowAssignment(row);
    if (!assignment) continue;
    const due = new Date(
      assignment.due.getFullYear(),
      assignment.due.getMonth(),
      assignment.due.getDate()
    );
    const show = activeFilter === "all" ||
      (activeFilter === "today" && due.getTime() === today.getTime()) ||
      (activeFilter === "week" && due >= weekStart && due < weekEnd) ||
      (activeFilter === "overdue" && due < today);
    row.hidden = !show;
  }
}

async function exportTaskBackup() {
  const tasks = await loadTasks();
  const backup = {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `alma-plus-tasks-${toCalendarDate(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importTaskBackup(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (error) {
    alert(`Could not read the backup file: ${error.message}`);
    return;
  }

  if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== 1 || !Array.isArray(backup.tasks)) {
    alert("This is not a supported Alma+ task backup.");
    return;
  }

  const importedTasks = backup.tasks.map(normalizeTask);
  if (importedTasks.some((task) => !task)) {
    alert("The backup contains an invalid task. No tasks were imported.");
    return;
  }

  const currentTasks = await loadTasks();
  const ids = new Set(currentTasks.map((task) => task.id));
  const mergedTasks = [...currentTasks];
  for (const task of importedTasks) {
    const id = ids.has(task.id) ? crypto.randomUUID() : task.id;
    ids.add(id);
    mergedTasks.push({ ...task, id });
  }
  await saveTasks(mergedTasks);
  alert(`Restored ${importedTasks.length} task${importedTasks.length === 1 ? "" : "s"}. Existing tasks were kept.`);
  renderCustomRows();
}

function buildImportInput() {
  const input = document.createElement("input");
  input.id = "alma-plus-import-input";
  input.type = "file";
  input.accept = "application/json,.json";
  input.hidden = true;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) await importTaskBackup(file);
    input.value = "";
  });
  return input;
}

function ensureAddButton() {
  const table = findAssignmentsTable();
  if (table && !document.getElementById("alma-plus-add-btn")) {
    const toolbar = document.createElement("div");
    toolbar.id = "alma-plus-toolbar";
    toolbar.appendChild(buildAddButton());
    toolbar.appendChild(buildExportButton());
    toolbar.appendChild(buildBackupButton());
    toolbar.appendChild(buildImportButton());
    toolbar.appendChild(buildFilter());
    table.before(toolbar);
    table.before(buildImportInput());
  }
}

function openModal(existingTask = null) {
  if (document.getElementById("alma-plus-modal-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "alma-plus-modal-overlay";

  const modal = document.createElement("div");
  modal.id = "alma-plus-modal";
  modal.innerHTML = `
    <h3>Add your own task</h3>
    <label>Task name
      <input type="text" id="alma-plus-input-name" placeholder="e.g. Study for chem quiz">
    </label>
    <label>Class / category (optional)
      <input type="text" id="alma-plus-input-category" placeholder="e.g. P5 AP Biology">
    </label>
    <label>Notes (optional)
      <textarea id="alma-plus-input-notes" rows="3" placeholder="Add a reminder"></textarea>
    </label>
    <label>Priority
      <select id="alma-plus-input-priority">
        <option value="low">Low</option>
        <option value="normal">Normal</option>
        <option value="high">High</option>
      </select>
    </label>
    <label>Due date
      <input type="date" id="alma-plus-input-date">
    </label>
    <div class="alma-plus-modal-actions">
      <button type="button" id="alma-plus-cancel">Cancel</button>
      <button type="button" id="alma-plus-save">Add</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelector("h3").textContent = existingTask ? "Edit your task" : "Add your own task";
  modal.querySelector("#alma-plus-save").textContent = existingTask ? "Save" : "Add";
  modal.querySelector("#alma-plus-input-name").value = existingTask?.name || "";
  modal.querySelector("#alma-plus-input-category").value = existingTask?.category || "";
  modal.querySelector("#alma-plus-input-notes").value = existingTask?.notes || "";
  modal.querySelector("#alma-plus-input-priority").value = existingTask?.priority || "normal";
  modal.querySelector("#alma-plus-input-date").value = existingTask?.due || "";

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  modal.querySelector("#alma-plus-cancel").addEventListener("click", () => overlay.remove());
  modal.querySelector("#alma-plus-save").addEventListener("click", async () => {
    const name = modal.querySelector("#alma-plus-input-name").value.trim();
    const category = modal.querySelector("#alma-plus-input-category").value.trim();
    const notes = modal.querySelector("#alma-plus-input-notes").value.trim();
    const priority = modal.querySelector("#alma-plus-input-priority").value;
    const due = modal.querySelector("#alma-plus-input-date").value;

    if (!name || !due || !isValidDate(due)) {
      alert("Please enter a task name and a valid due date.");
      return;
    }

    const task = {
      ...(existingTask || {}),
      name,
      category,
      notes,
      priority,
      due,
    };
    if (existingTask) await updateTask(task);
    else await addTask(task);
    overlay.remove();
    renderCustomRows();
  });

  modal.querySelector("#alma-plus-input-name").focus();
}

function scheduleRender() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    ensureAddButton();
    renderCustomRows();
  }, 80);
}

function startObserving() {
  bodyObserver = new MutationObserver(scheduleRender);
  bodyObserver.observe(document.body, { childList: true, subtree: true });
}

function init() {
  ensureAddButton();
  renderCustomRows();
  startObserving();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
