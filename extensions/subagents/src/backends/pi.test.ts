import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolvePiModel } from "./pi.ts";

const customModel = {
  provider: "openrouter",
  id: "meta/muse-spark-1.2-contributor",
} as Model<any>;

const registryWithoutCustomModel = {
  find: () => undefined,
  getAll: () => [],
} as unknown as ModelRegistry;

test("inherited custom models do not need to exist in the parent registry", () => {
  assert.equal(resolvePiModel(registryWithoutCustomModel, undefined, customModel), customModel);
  assert.equal(resolvePiModel(registryWithoutCustomModel, customModel.id, customModel), customModel);
  assert.equal(
    resolvePiModel(registryWithoutCustomModel, `${customModel.provider}/${customModel.id}`, customModel),
    customModel,
  );
});

test("unknown non-inherited models still fail closed", () => {
  assert.throws(
    () => resolvePiModel(registryWithoutCustomModel, "openrouter/not-configured", customModel),
    /Unknown model/,
  );
});
