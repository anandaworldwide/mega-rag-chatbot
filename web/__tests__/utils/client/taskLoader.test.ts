describe("taskLoader", () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
  });

  async function importTaskLoader() {
    return import("@/utils/client/taskLoader");
  }

  it("returns cached registry on subsequent calls", async () => {
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [{ taskId: "task-a", enabled: true, label: "Task A" }] }),
    } as Response);

    const { loadTaskRegistry } = await importTaskLoader();
    const first = await loadTaskRegistry();
    const second = await loadTaskRegistry();

    expect(first?.tasks).toHaveLength(1);
    expect(second).toBe(first);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null when registry fetch fails", async () => {
    jest.mocked(global.fetch).mockResolvedValue({ ok: false } as Response);
    const { loadTaskRegistry } = await importTaskLoader();
    await expect(loadTaskRegistry()).resolves.toBeNull();
  });

  it("loads and caches task definitions", async () => {
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: "task-a", title: "Task A" }),
    } as Response);

    const { loadTaskDefinition } = await importTaskLoader();
    const definition = await loadTaskDefinition("task-a");
    expect(definition).toEqual({ id: "task-a", title: "Task A" });
    expect(global.fetch).toHaveBeenCalledWith("/site-config/tasks/task-a.json");
  });

  it("returns empty array when no enabled task ids provided", async () => {
    const { getEnabledTasks } = await importTaskLoader();
    await expect(getEnabledTasks()).resolves.toEqual([]);
    await expect(getEnabledTasks([])).resolves.toEqual([]);
  });

  it("filters enabled tasks by site configuration", async () => {
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tasks: [
          { taskId: "task-a", enabled: true, label: "A" },
          { taskId: "task-b", enabled: false, label: "B" },
          { taskId: "task-c", enabled: true, label: "C" },
        ],
      }),
    } as Response);

    const { getEnabledTasks } = await importTaskLoader();
    const enabled = await getEnabledTasks(["task-a", "task-c"]);
    expect(enabled.map((t) => t.taskId)).toEqual(["task-a", "task-c"]);
  });
});
