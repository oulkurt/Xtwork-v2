const priorities = ["none", "low", "medium", "high"];
const filters = ["all", "today", "week", "done", "overdue"];
const fields = [
  "title",
  "notes",
  "group",
  "due",
  "time",
  "priority",
];
const key = (id) => `item:${id}`;
const dateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const length = (s) => Array.from(s).length;

function byteLength(value) {
  return Array.from(JSON.stringify(value)).reduce((sum, char) => {
    const n = char.codePointAt(0);
    return sum + (n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4);
  }, 0);
}

function validateId(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string" || !input.id) {
    throw new Error("id is required.");
  }
}

function validate(input, creating = false) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected an object.");
  for (const name of fields) {
    if (input[name] !== undefined && typeof input[name] !== "string")
      throw new Error(`${name} must be a string.`);
  }
  if (
    (creating || input.title !== undefined) &&
    (!input.title || !input.title.trim() || length(input.title) > 200)
  )
    throw new Error("title must contain 1–200 characters.");
  if (input.notes !== undefined && length(input.notes) > 2000)
    throw new Error("notes must contain at most 2000 characters.");
  if (input.group !== undefined && length(input.group) > 40)
    throw new Error("group must contain at most 40 characters.");
  if (input.priority !== undefined && !priorities.includes(input.priority))
    throw new Error("priority must be none, low, medium, or high.");
  if (input.due) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.due))
      throw new Error("due must be a local date in YYYY-MM-DD format.");
    const [y, m, d] = input.due.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (
      date.getFullYear() !== y ||
      date.getMonth() !== m - 1 ||
      date.getDate() !== d
    )
      throw new Error("due must be a valid local date.");
  }
  if (input.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))
    throw new Error("time must be in HH:MM format.");
  if (input.time && !input.due) throw new Error("time requires due.");
}
async function all() {
  const keys = await xtwork.storage.list("item:");
  return (await xtwork.storage.getMany(keys)).filter(Boolean);
}
async function create(input, context) {
  validate(input, true);
  let id;
  if (context?.operationKey) {
    id = `req-${context.operationKey}`;
    const previous = await xtwork.storage.get(key(id));
    if (previous) return previous;
  }
  if ((await xtwork.storage.list("item:")).length >= 1000)
    throw new Error("The 1000 item limit has been reached.");
  if (!id) {
    do {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    } while (await xtwork.storage.get(key(id)));
  }
  const now = new Date().toISOString();
  const item = {
    id,
    title: input.title.trim(),
    notes: input.notes || "",
    group: (input.group || "").trim(),
    due: input.due || "",
    time: input.time || "",
    priority: input.priority || "none",
    done: false,
    doneAt: "",
    createdAt: now,
    updatedAt: now,
    ...(context?.threadId ? { sourceThreadId: context.threadId } : {}),
  };
  await xtwork.storage.set(key(item.id), item);
  return item;
}
function select(items, input = {}) {
  const filter = input.filter || "all";
  if (!filters.includes(filter))
    throw new Error("filter must be all, today, week, done, or overdue.");
  if (input.group !== undefined && typeof input.group !== "string")
    throw new Error("group must be a string.");
  const now = new Date(),
    today = dateKey(now),
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6),
    last = dateKey(end);
  return items
    .filter(
      (item) =>
        (input.group === undefined || item.group === input.group) &&
        (filter === "done"
          ? item.done
          : !item.done &&
            (filter === "all" ||
              (filter === "today" && item.due === today) ||
              (filter === "week" && item.due >= today && item.due <= last) ||
              (filter === "overdue" && item.due && item.due < today))),
    )
    .sort((a, b) =>
      filter === "done"
        ? b.doneAt.localeCompare(a.doneAt)
        : (a.due || "9999").localeCompare(b.due || "9999") ||
          (a.time || "99:99").localeCompare(b.time || "99:99") ||
          priorities.indexOf(b.priority) - priorities.indexOf(a.priority) ||
          a.createdAt.localeCompare(b.createdAt),
    );
}
const actions = {
  create,
  update: async (input) => {
    validateId(input);
    const current = await xtwork.storage.get(key(input.id));
    if (!current) throw new Error("Todo not found.");
    const changes = { ...input };
    delete changes.id;
    const next = {
      ...current,
      ...Object.fromEntries(fields.map((name) => [name, changes[name] ?? current[name]])),
    };
    if (!next.due && (changes.time === undefined || changes.time === "")) next.time = "";
    validate(next);
    next.title = next.title.trim();
    next.group = next.group.trim();
    const now = new Date().toISOString();
    const item = {
      ...next,
      updatedAt: now,
    };
    await xtwork.storage.set(key(item.id), item);
    return item;
  },
  complete: async (input) => {
    validateId(input);
    const current = await xtwork.storage.get(key(input.id));
    if (!current) throw new Error("Todo not found.");
    const done = input.done === undefined ? true : input.done;
    if (typeof done !== "boolean") throw new Error("done must be a boolean.");
    const now = new Date().toISOString();
    const item = {
      ...current,
      done,
      doneAt: done ? now : "",
      updatedAt: now,
    };
    await xtwork.storage.set(key(item.id), item);
    return item;
  },
  delete: async (input) => {
    validateId(input);
    const current = await xtwork.storage.get(key(input.id));
    if (!current) throw new Error("Todo not found.");
    await xtwork.storage.delete(key(input.id));
    return { id: input.id, deleted: true };
  },
  list: async (input) => {
    const { limit = 50, offset = 0, fullNotes = false } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("limit must be an integer from 1 to 200.");
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000)
      throw new Error("offset must be an integer from 0 to 1000.");
    if (typeof fullNotes !== "boolean") throw new Error("fullNotes must be a boolean.");
    const items = select(await all(), input);
    const result = [];
    let size = 0;
    for (const item of items.slice(offset, offset + limit)) {
      const chars = Array.from(item.notes);
      const compact =
        !fullNotes && chars.length > 200
          ? {
              ...item,
              notes: chars.slice(0, 200).join(""),
              notesTruncated: true,
            }
          : item;
      const bytes = byteLength(compact);
      if (size + bytes > 100000) break;
      size += bytes;
      result.push(compact);
    }
    const next = offset + result.length;
    return { total: items.length, items: result, nextOffset: next < items.length ? next : null };
  },
};
export const tools = actions;

export function onView(method, input) {
  if (!(method in actions)) throw new Error("Unknown todo action.");
  return actions[method](input);
}
