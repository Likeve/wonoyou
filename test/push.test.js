import { test } from "node:test";
import assert from "node:assert/strict";
import { pushFailure } from "../server/push.js";

test("only permanently expired push endpoints are removed", () => {
  assert.deepEqual(pushFailure({ statusCode: 404 }), { sent: false, expired: true });
  assert.deepEqual(pushFailure({ statusCode: 410 }), { sent: false, expired: true });
  assert.deepEqual(pushFailure({ statusCode: 429 }), { sent: false, expired: false });
  assert.deepEqual(pushFailure({ statusCode: 503 }), { sent: false, expired: false });
  assert.deepEqual(pushFailure(new Error("temporary network failure")), {
    sent: false,
    expired: false,
  });
});
