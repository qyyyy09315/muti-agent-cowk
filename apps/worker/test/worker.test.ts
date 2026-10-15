import assert from "node:assert/strict";
import { test } from "node:test";
import { HubClient } from "../src/client.js";

test("HubClient mock validation", () => {
  const client = new HubClient("http://127.0.0.1:3100", "mock_token");
  assert.equal(client.baseUrl, "http://127.0.0.1:3100");
  assert.equal(client.token, "mock_token");
});
