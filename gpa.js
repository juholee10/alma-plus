(() => {
  const INCLUDED_KEY = "almaPlusGpaIncluded";

  // unweighted 4.0 scale, keyed by the letter Alma shows
  const GRADE_POINTS = {
    "A+": 4.0, "A": 4.0, "A-": 3.7,
    "B+": 3.3, "B": 3.0, "B-": 2.7,
    "C+": 2.3, "C": 2.0, "C-": 1.7,
    "D+": 1.3, "D": 1.0, "D-": 0.7,
    "F": 0.0,
  };

  // not part of a GPA unless the student ticks them
  const EXCLUDED_BY_DEFAULT = /cocurricular|advisory|study hall/i;

  let observer = null;
  let timer = null;

  async function loadIncluded() {
    const result = await chrome.storage.local.get(INCLUDED_KEY);
    const stored = result[INCLUDED_KEY];
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  }

  // read-modify-write, so hold a lock or two tabs saving at once can drop a choice
  function setIncluded(classId, included) {
    const run = async () => {
      const stored = await loadIncluded();
      stored[classId] = included;
      await chrome.storage.local.set({ [INCLUDED_KEY]: stored });
    };
    return navigator.locks ? navigator.locks.request("alma-plus-gpa", run) : run();
  }

  // grade cell is `A <small>(98.9%)</small>`, or `-` when nothing is graded
  function parseLetter(cell) {
    const text = [...cell.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join("")
      .replace(/−/g, "-")
      .trim()
      .toUpperCase();
    return text in GRADE_POINTS ? text : null;
  }

  function readClasses(table) {
    return [...table.querySelectorAll("tbody tr.result-set-item")]
      .map((row) => {
        const gradeCell = row.querySelector("td.grade");
        const id = row.dataset.id;
        if (!gradeCell || !id) return null;
        const name = (row.querySelector("th.name")?.textContent || "").replace(/\s+/g, " ").trim();
        return { row, gradeCell, id, name, letter: parseLetter(gradeCell) };
      })
      .filter(Boolean);
  }

  function isCounted(cls, included) {
    if (!cls.letter) return false;
    return cls.id in included ? included[cls.id] === true : !EXCLUDED_BY_DEFAULT.test(cls.name);
  }

  function computeGpa(classes, included) {
    const counted = classes.filter((c) => isCounted(c, included));
    if (!counted.length) return { gpa: null, count: 0 };
    const total = counted.reduce((sum, c) => sum + GRADE_POINTS[c.letter], 0);
    return { gpa: total / counted.length, count: counted.length };
  }

  function ensureCheckbox(cls, included) {
    if (!cls.letter) {
      cls.gradeCell.querySelector(".alma-plus-gpa-check")?.remove();
      return;
    }
    let box = cls.gradeCell.querySelector(".alma-plus-gpa-check");
    if (!box) {
      box = document.createElement("input");
      box.type = "checkbox";
      box.className = "alma-plus-gpa-check";
      box.title = "Count this class in GPA";
      box.addEventListener("change", async () => {
        box.disabled = true;
        try {
          await setIncluded(cls.id, box.checked);
        } finally {
          box.disabled = false;
          render();
        }
      });
      cls.gradeCell.appendChild(box);
    }
    box.checked = isCounted(cls, included);
  }

  function ensureSummary(table) {
    let box = table.previousElementSibling;
    if (!box?.classList.contains("alma-plus-gpa-summary")) {
      box = document.createElement("div");
      box.className = "alma-plus-gpa-summary";
      table.before(box);
    }
    return box;
  }

  function fillSummary(box, { gpa, count }) {
    box.replaceChildren();

    const label = document.createElement("span");
    label.className = "alma-plus-gpa-label";
    label.textContent = "GPA (unweighted 4.0)";

    const value = document.createElement("span");
    value.className = "alma-plus-gpa-value";
    value.textContent = gpa === null ? "N/A" : gpa.toFixed(2);

    const note = document.createElement("span");
    note.className = "alma-plus-gpa-note";
    note.textContent = count
      ? `from ${count} graded ${count === 1 ? "class" : "classes"}. Use the checkboxes in the Grade column to include or leave out a class.`
      : "No graded classes yet.";

    box.append(label, value, note);
  }

  async function render() {
    const tables = document.querySelectorAll("table.student-classes");
    if (!tables.length) return;

    let included;
    try {
      included = await loadIncluded();
    } catch {
      return; // extension was reloaded while this tab stayed open
    }

    observer?.disconnect();
    try {
      for (const table of tables) {
        const classes = readClasses(table);
        classes.forEach((cls) => ensureCheckbox(cls, included));
        fillSummary(ensureSummary(table), computeGpa(classes, included));
      }
    } finally {
      observer?.observe(document.body, { childList: true, subtree: true });
    }
  }

  function scheduleRender() {
    clearTimeout(timer);
    timer = setTimeout(render, 100);
  }

  function init() {
    observer = new MutationObserver(scheduleRender);
    render();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
