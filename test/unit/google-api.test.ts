// Direct coverage of the Google Tasks API URL/method builders in
// src/google/api.ts. The GoogleClient fetch seam is faithful: it records each
// request and replays a canned Response, so every optional query-parameter
// branch and the 204/no-body and error paths are exercised without the network.
import { describe, expect, it } from "vitest";
import type { GoogleClient } from "../../src/google/client.ts";
import {
  clearTasks,
  deleteTask,
  deleteTaskList,
  getTask,
  getTaskList,
  insertTask,
  insertTaskList,
  listTaskLists,
  listTasks,
  moveTask,
  patchTask,
  patchTaskList,
  updateTask,
  updateTaskList,
} from "../../src/google/api.ts";

type Recorded = { url: URL; method: string; body: string | null };

function fakeClient(response: { status: number; body?: unknown }): { client: GoogleClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client: GoogleClient = {
    getAccessToken: () => Promise.resolve("PLANTED_GOOGLE_ACCESS_A"),
    fetch: ((input, init) => {
      const req = new Request(input, init);
      calls.push({ url: new URL(req.url), method: req.method, body: init?.body ? String(init.body) : null });
      const text = response.status === 204 || response.body === undefined ? null : JSON.stringify(response.body);
      return Promise.resolve(new Response(text, { status: response.status }));
    }) as typeof fetch,
  };
  return { client, calls };
}

const L = "PLANTED_LIST_1";
const T = "PLANTED_TASK_1";

describe("google api builders", () => {
  it("listTaskLists_passes_maxResults_and_pageToken", async () => {
    const { client, calls } = fakeClient({ status: 200, body: { items: [] } });
    await listTaskLists(client, 50, "PAGE2");
    const u = calls[0].url;
    expect(u.pathname).toBe("/tasks/v1/users/@me/lists");
    expect(u.searchParams.get("maxResults")).toBe("50");
    expect(u.searchParams.get("pageToken")).toBe("PAGE2");
  });

  it("listTaskLists_omits_absent_params", async () => {
    const { client, calls } = fakeClient({ status: 200, body: { items: [] } });
    await listTaskLists(client);
    expect(calls[0].url.search).toBe("");
  });

  it("getTaskList_insert_update_patch_delete", async () => {
    const { client, calls } = fakeClient({ status: 200, body: { id: L } });
    await getTaskList(client, L);
    await insertTaskList(client, "New");
    await updateTaskList(client, L, "Renamed");
    await patchTaskList(client, L, { title: "Patched" });
    await deleteTaskList(client, L);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    expect(JSON.parse(calls[1].body!)).toEqual({ title: "New" });
    expect(JSON.parse(calls[2].body!)).toEqual({ id: L, title: "Renamed" });
  });

  it("listTasks_appends_every_optional_filter", async () => {
    const { client, calls } = fakeClient({ status: 200, body: { items: [] } });
    await listTasks(client, L, {
      completedMax: "2026-01-02T00:00:00.000Z",
      completedMin: "2026-01-01T00:00:00.000Z",
      dueMax: "2026-02-02T00:00:00.000Z",
      dueMin: "2026-02-01T00:00:00.000Z",
      maxResults: 20,
      pageToken: "PAGE3",
      showCompleted: true,
      showDeleted: false,
      showHidden: true,
      updatedMin: "2026-03-01T00:00:00.000Z",
    });
    const q = calls[0].url.searchParams;
    expect(q.get("completedMax")).toBe("2026-01-02T00:00:00.000Z");
    expect(q.get("completedMin")).toBe("2026-01-01T00:00:00.000Z");
    expect(q.get("dueMax")).toBe("2026-02-02T00:00:00.000Z");
    expect(q.get("dueMin")).toBe("2026-02-01T00:00:00.000Z");
    expect(q.get("maxResults")).toBe("20");
    expect(q.get("pageToken")).toBe("PAGE3");
    expect(q.get("showCompleted")).toBe("true");
    expect(q.get("showDeleted")).toBe("false");
    expect(q.get("showHidden")).toBe("true");
    expect(q.get("updatedMin")).toBe("2026-03-01T00:00:00.000Z");
  });

  it("listTasks_without_options_has_no_query", async () => {
    const { client, calls } = fakeClient({ status: 200, body: { items: [] } });
    await listTasks(client, L);
    expect(calls[0].url.search).toBe("");
  });

  it("getTask_insertTask_updateTask_patchTask_deleteTask", async () => {
    const { client, calls } = fakeClient({ status: 200, body: { id: T } });
    await getTask(client, L, T);
    await insertTask(client, L, { title: "A" });
    await insertTask(client, L, { title: "B" }, "PLANTED_PARENT", "PLANTED_PREV");
    await updateTask(client, L, T, { title: "U" });
    await patchTask(client, L, T, { title: "P" });
    await deleteTask(client, L, T);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "PUT", "PATCH", "DELETE"]);
    // The second insert carries parent/previous in the query string.
    expect(calls[2].url.searchParams.get("parent")).toBe("PLANTED_PARENT");
    expect(calls[2].url.searchParams.get("previous")).toBe("PLANTED_PREV");
    // The first insert omits them.
    expect(calls[1].url.search).toBe("");
    expect(JSON.parse(calls[3].body!)).toEqual({ title: "U", id: T });
  });

  it("clearTasks_returns_null_for_204", async () => {
    const { client, calls } = fakeClient({ status: 204 });
    expect(await clearTasks(client, L)).toBeNull();
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe(`/tasks/v1/lists/${L}/clear`);
  });

  it("moveTask_with_and_without_placement", async () => {
    const withPlacement = fakeClient({ status: 200, body: { id: T } });
    await moveTask(withPlacement.client, L, T, "PLANTED_PARENT", "PLANTED_PREV");
    expect(withPlacement.calls[0].url.searchParams.get("parent")).toBe("PLANTED_PARENT");
    expect(withPlacement.calls[0].url.searchParams.get("previous")).toBe("PLANTED_PREV");

    const bare = fakeClient({ status: 200, body: { id: T } });
    await moveTask(bare.client, L, T);
    expect(bare.calls[0].url.search).toBe("");
  });

  it("non_ok_response_throws_with_status_and_body", async () => {
    const { client } = fakeClient({ status: 404, body: { error: { message: "Not Found" } } });
    await expect(getTaskList(client, L)).rejects.toThrow(/404/);
  });

  it("insertTaskList_parses_json_body_on_success", async () => {
    const { client } = fakeClient({ status: 200, body: { id: "PLANTED_LIST_NEW", title: "New" } });
    expect(await insertTaskList(client, "New")).toEqual({ id: "PLANTED_LIST_NEW", title: "New" });
  });
});
