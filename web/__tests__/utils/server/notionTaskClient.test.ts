import { NotionTaskClient } from "@/utils/server/notionTaskClient";
import { DownvoteFeedbackCluster } from "@/types/downvoteFeedback";

const TEST_CLUSTER: DownvoteFeedbackCluster = {
  key: "retrieval_bug::broken_links",
  label: "Broken links in citation",
  triageCategory: "bad_source_link",
  totalEvents: 3,
  identifiedCount: 2,
  taskCreatedCount: 0,
  latestCreatedAt: "2026-04-14T00:00:00.000Z",
  sampleQuestions: ["Why is this source link broken?"],
  sampleComments: ["404 when opening citation"],
  averageConfidence: 0.89,
  recommendedAction: "Fix source link generation",
};

describe("NotionTaskClient", () => {
  const originalEnv = process.env;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("creates a page under parent page id when database id is not configured", async () => {
    process.env.NOTION_API_KEY = "test-key";
    process.env.NOTION_DOWNVOTE_PARENT_PAGE_ID = "parent-page-id";
    delete process.env.NOTION_DOWNVOTE_TASK_DATABASE_ID;

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "new-page-id", url: "https://notion.so/new-page-id" }),
    });

    const client = new NotionTaskClient();
    const result = await client.createDraftTask(TEST_CLUSTER);

    expect(result).toEqual({ id: "new-page-id", url: "https://notion.so/new-page-id" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestOptions = fetchMock.mock.calls[0][1] as { body: string };
    const body = JSON.parse(requestOptions.body);
    expect(body.parent).toEqual({ type: "page_id", page_id: "parent-page-id" });
    expect(body.properties.title).toBeDefined();
  });

  it("creates a database task with status hard-set to To Do", async () => {
    process.env.NOTION_API_KEY = "test-key";
    process.env.NOTION_DOWNVOTE_TASK_DATABASE_ID = "task-db-id";
    delete process.env.NOTION_DOWNVOTE_PARENT_PAGE_ID;

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            Name: { type: "title" },
            Status: { type: "status" },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "new-task-id", url: "https://notion.so/new-task-id" }),
      });

    const client = new NotionTaskClient();
    const result = await client.createDraftTask(TEST_CLUSTER);

    expect(result).toEqual({ id: "new-task-id", url: "https://notion.so/new-task-id" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/databases/task-db-id");
    const requestOptions = fetchMock.mock.calls[1][1] as { body: string };
    const body = JSON.parse(requestOptions.body);
    expect(body.parent).toEqual({ type: "database_id", database_id: "task-db-id" });
    expect(body.properties.Name).toBeDefined();
    expect(body.properties.Status).toEqual({ status: { name: "To Do" } });
  });

  it("reuses tasks only when status is To Do or Doing", async () => {
    process.env.NOTION_API_KEY = "test-key";
    process.env.NOTION_DOWNVOTE_TASK_DATABASE_ID = "task-db-id";

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            Status: { type: "status", status: { name: "To Do" } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            Status: { type: "status", status: { name: "Doing" } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            Status: { type: "status", status: { name: "Done" } },
          },
        }),
      });

    const client = new NotionTaskClient();
    await expect(client.isTaskOpenForReuse("todo-task-id")).resolves.toBe(true);
    await expect(client.isTaskOpenForReuse("doing-task-id")).resolves.toBe(true);
    await expect(client.isTaskOpenForReuse("done-task-id")).resolves.toBe(false);
  });

  it("does not reuse archived or verify/review tasks", async () => {
    process.env.NOTION_API_KEY = "test-key";
    process.env.NOTION_DOWNVOTE_TASK_DATABASE_ID = "task-db-id";

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          archived: true,
          properties: {
            Status: { type: "status", status: { name: "To Do" } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            Status: { type: "status", status: { name: "Test / Review" } },
          },
        }),
      });

    const client = new NotionTaskClient();
    await expect(client.isTaskOpenForReuse("archived-task-id")).resolves.toBe(false);
    await expect(client.isTaskOpenForReuse("verify-task-id")).resolves.toBe(false);
  });

  it("uses a workflow multi-select property when that contains To Do", async () => {
    process.env.NOTION_API_KEY = "test-key";
    process.env.NOTION_DOWNVOTE_TASK_DATABASE_ID = "task-db-id";
    delete process.env.NOTION_DOWNVOTE_PARENT_PAGE_ID;

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            Name: { type: "title" },
            Lane: {
              type: "multi_select",
              multi_select: {
                options: [{ name: "To Do" }, { name: "Doing" }, { name: "Done" }],
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "new-task-id", url: "https://notion.so/new-task-id" }),
      });

    const client = new NotionTaskClient();
    const result = await client.createDraftTask(TEST_CLUSTER);

    expect(result).toEqual({ id: "new-task-id", url: "https://notion.so/new-task-id" });
    const requestOptions = fetchMock.mock.calls[1][1] as { body: string };
    const body = JSON.parse(requestOptions.body);
    expect(body.properties.Lane).toEqual({ multi_select: [{ name: "To Do" }] });
  });

});
