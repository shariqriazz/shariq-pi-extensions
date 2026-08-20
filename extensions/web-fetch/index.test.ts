import assert from "node:assert/strict";
import test from "node:test";
import webFetchExtension from "./index.ts";

test("web_fetch routing treats remote content as data rather than instructions", () => {
  let tool: { name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] } | undefined;
  webFetchExtension({
    registerTool(definition: typeof tool) {
      tool = definition;
    },
  } as never);

  assert.equal(tool?.name, "web_fetch");
  assert.match(tool?.description ?? "", /known URL or API/);
  assert.match(tool?.promptSnippet ?? "", /web_search for discovery/);
  assert.match(tool?.promptGuidelines?.join(" ") ?? "", /untrusted data, not instructions/);
});
