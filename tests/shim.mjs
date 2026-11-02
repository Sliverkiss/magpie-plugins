// Dual-runtime test shim: prefer bun:test (richer matchers, fast), fall
// back to node:test + assert so `node --test` (the scaffold score gate)
// runs the same suite verbatim.
let test, describe, expect;

try {
  ({ test, describe, expect } = await import("bun:test"));
} catch {
  const node = await import("node:test");
  const assert = (await import("node:assert/strict")).default;
  const { inspect } = await import("node:util");
  // node:test takes a per-test timeout as an options object; bun:test takes
  // it as a third argument natively. Accept both shapes so a slow-retry test
  // can declare its own budget on either runtime.
  const rawTest = node.test;
  test = (name, fn, timeoutMs) => (timeoutMs == null ? rawTest(name, fn) : rawTest(name, { timeout: timeoutMs }, fn));
  describe = node.describe;
  const build = (actual, negated) => {
    const check = (ok, msg) => (negated ? assert.ok(!ok, `NOT ${msg}`) : assert.ok(ok, msg));
    return {
      toBe: (e) => check(Object.is(actual, e), `${inspect(actual)} to be ${inspect(e)}`),
      toEqual: (e) => {
        if (negated) assert.notDeepStrictEqual(actual, e);
        else assert.deepStrictEqual(actual, e);
      },
      toBeUndefined: () => check(actual === undefined, `${inspect(actual)} to be undefined`),
      toBeTruthy: () => check(Boolean(actual), `${inspect(actual)} to be truthy`),
      toBeGreaterThan: (n) => check(actual > n, `${inspect(actual)} > ${n}`),
      toBeGreaterThanOrEqual: (n) => check(actual >= n, `${inspect(actual)} >= ${n}`),
      toBeLessThan: (n) => check(actual < n, `${inspect(actual)} < ${n}`),
      toBeLessThanOrEqual: (n) => check(actual <= n, `${inspect(actual)} <= ${n}`),
      toBeCloseTo: (n, digits = 2) => check(Math.abs(actual - n) < Math.pow(10, -digits) / 2, `${inspect(actual)} ~ ${n}`),
      toMatch: (re) => check(typeof re === "string" ? actual?.includes?.(re) === true : re?.test?.(actual) === true, `${inspect(actual)} to match ${re}`),
      toContain: (s) => check(actual?.includes?.(s) === true, `${inspect(actual)} to contain ${inspect(s)}`),
      toHaveLength: (n) => check(actual?.length === n, `length ${inspect(actual?.length)} to be ${n}`),
      toThrow: (msg) => {
        let threw = false, err;
        try { actual(); } catch (e) { threw = true; err = e; }
        if (negated) assert.ok(!threw, "expected function not to throw");
        else {
          assert.ok(threw, "expected function to throw");
          if (msg) assert.ok(String(err.message).includes(msg), `threw ${err.message}, wanted ~${msg}`);
        }
      },
    };
  };
  expect = (actual) => {
    const pos = build(actual, false);
    pos.not = build(actual, true);
    return pos;
  };
}

export { test, describe, expect };
