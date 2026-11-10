import { Hono } from "hono";
import { createTaskSchema, updateTaskSchema } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

/** The team task board. Assigning a task to a Bot wakes it with the task. */
export const tasksRoutes = new Hono<AppEnv>();

tasksRoutes.get("/", (c) => {
  const all = c.req.query("all") === "1";
  return c.json(c.get("store").tasks.list({ includeClosed: all }));
});

tasksRoutes.post("/", async (c) => {
  const parsed = createTaskSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const owner = parsed.data.ownerBotId ? store.bots.get(parsed.data.ownerBotId) : undefined;
  if (parsed.data.ownerBotId && !owner) return c.json({ error: "Unknown owner Bot" }, 400);
  const task = store.tasks.create({ ...parsed.data, ownerBotId: owner?.id ?? null, createdBy: null });
  c.get("emit")({ type: "task.updated", task });
  if (owner) {
    const id8 = task.id.slice(0, 8);
    c.get("runtime").postSystemAndWake(
      owner.id,
      `New task from the user [${id8}] (${task.priority}${task.dueAt ? `, due ${task.dueAt}` : ""}): ${task.title}\n${task.detail}\nWhen finished call task_update {"id":"${id8}","status":"done","result":"…"} with the actual result.`,
    );
  }
  return c.json(task, 201);
});

tasksRoutes.patch("/:id", async (c) => {
  const parsed = updateTaskSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const before = store.tasks.get(c.req.param("id"));
  if (!before) return c.json({ error: "Not found" }, 404);
  const task = store.tasks.update(before.id, parsed.data)!;
  c.get("emit")({ type: "task.updated", task });
  if (task.ownerBotId && task.ownerBotId !== before.ownerBotId) {
    c.get("runtime").postSystemAndWake(task.ownerBotId, `The user assigned you task [${task.id.slice(0, 8)}]: ${task.title}\n${task.detail}\nUpdate it with task_update when done.`);
  }
  return c.json(task);
});

tasksRoutes.delete("/:id", (c) => {
  const store = c.get("store");
  store.tasks.delete(c.req.param("id"));
  c.get("emit")({ type: "task.deleted", taskId: c.req.param("id") });
  return c.body(null, 204);
});
