import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billingPoolForModel,
  exhaustedBucket,
  formatPoolLimits,
  type FactoryPoolLimits,
} from "./limits.ts";

const now = Date.parse("2026-08-20T12:00:00Z");
const future = "2026-08-21T12:00:00Z";
const past = "2026-08-19T12:00:00Z";

function limits(values: Partial<Record<"fiveHour" | "weekly" | "monthly", number>>): FactoryPoolLimits {
  return {
    fiveHour: { usedPercent: values.fiveHour ?? 0, windowEnd: future, secondsRemaining: 3600 },
    weekly: { usedPercent: values.weekly ?? 0, windowEnd: future, secondsRemaining: 3600 },
    monthly: { usedPercent: values.monthly ?? 0, windowEnd: future, secondsRemaining: 3600 },
  };
}

test("monthly and weekly exhaustion suppress less relevant windows", () => {
  const monthly = limits({ monthly: 100, weekly: 100, fiveHour: 100 });
  assert.equal(exhaustedBucket(monthly, now), "monthly");
  assert.match(formatPoolLimits("Standard", monthly, now), /weekly\/5h inactive/);

  const weekly = limits({ monthly: 40, weekly: 100, fiveHour: 100 });
  assert.equal(exhaustedBucket(weekly, now), "weekly");
  assert.match(formatPoolLimits("Standard", weekly, now), /5h inactive/);
});

test("eligibility is a monthly → weekly → 5-hour waterfall", () => {
  assert.equal(exhaustedBucket(limits({ monthly: 100, weekly: 0, fiveHour: 0 }), now), "monthly");
  assert.equal(exhaustedBucket(limits({ monthly: 50, weekly: 100, fiveHour: 0 }), now), "weekly");
  assert.equal(exhaustedBucket(limits({ monthly: 50, weekly: 50, fiveHour: 100 }), now), "fiveHour");
  assert.equal(exhaustedBucket(limits({ monthly: 99, weekly: 99, fiveHour: 99 }), now), undefined);
});

test("secondsRemaining is anchored to fetch time and cannot extend a stale cooldown", () => {
  const value = limits({ weekly: 100 });
  value.weekly = { usedPercent: 100, windowEnd: null, secondsRemaining: 3_600 };
  assert.equal(exhaustedBucket(value, now, now - 30 * 60_000), "weekly");
  assert.equal(exhaustedBucket(value, now, now - 2 * 60 * 60_000), undefined);
});

test("expired exhaustion does not block a credential", () => {
  const value = limits({ weekly: 100 });
  value.weekly = { usedPercent: 100, windowEnd: past, secondsRemaining: null };
  assert.equal(exhaustedBucket(value, now), undefined);
  assert.doesNotMatch(formatPoolLimits("Standard", value, now), /weekly 100%/i);
});

test("Droid Core models use the independent core pool", () => {
  assert.equal(billingPoolForModel("kimi-k3"), "core");
  assert.equal(billingPoolForModel("deepseek-v4-pro"), "core");
  assert.equal(billingPoolForModel("gpt-5.6-luna"), "standard");
});
