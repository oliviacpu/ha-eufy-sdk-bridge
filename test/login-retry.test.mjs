import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginStatus } from "@mega-yfue/eufy-sdk";
import { createState } from "../src/state.mjs";
import { createAuth, LOGIN_RETRY_MS, isCredentialError } from "../src/auth.mjs";

/** createAuth against a fake eufy whose login() plays back `results` (an Error is thrown, anything else returned). */
function authFixture(results, { loginRetry = true } = {}) {
  const state = createState();
  const calls = { login: 0, boots: 0, events: [] };
  const eufy = {
    pollIntervalMs: 600_000,
    async login() {
      calls.login += 1;
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    async disconnect() {},
    setPollInterval() {},
    forgetDevices() {},
  };
  const ctx = {
    cfg: { loginRetry },
    eufy,
    state,
    async completeBoot() {
      calls.boots += 1;
      state.flags.ready = true;
    },
    broadcast(msg) {
      calls.events.push(msg.state);
    },
  };
  Object.assign(ctx, createAuth(ctx));
  return { ctx, state, calls };
}

const quiet = (t) => t.mock.method(console, "error", () => {});
const settle = () => new Promise((r) => setImmediate(r));

test("a boot login that fails on the network is retried until it logs in", async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, state, calls } = authFixture([
    new TypeError("fetch failed"),
    new TypeError("fetch failed"),
    { status: LoginStatus.Ok },
  ]);

  await ctx.login();
  assert.equal(calls.login, 1);
  assert.equal(ctx.authStatus().state, "pending");
  assert.ok(state.timers.loginRetry, "a retry is scheduled");

  t.mock.timers.tick(LOGIN_RETRY_MS[0]);
  await settle();
  assert.equal(calls.login, 2);

  t.mock.timers.tick(LOGIN_RETRY_MS[1] - 1);
  await settle();
  assert.equal(calls.login, 2, "the second wait is longer than the first");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.login, 3);
  assert.equal(ctx.authStatus().state, "ok");
  assert.equal(calls.boots, 1);
  assert.equal(state.timers.loginRetry, null, "nothing left scheduled once logged in");
});

test("the wait grows to the last step and stays there", async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fails = Array.from({ length: LOGIN_RETRY_MS.length + 2 }, () => new TypeError("fetch failed"));
  const { ctx, calls } = authFixture(fails);
  await ctx.login();
  for (const wait of [...LOGIN_RETRY_MS, LOGIN_RETRY_MS.at(-1), LOGIN_RETRY_MS.at(-1)]) {
    const before = calls.login;
    t.mock.timers.tick(wait);
    await settle();
    assert.equal(calls.login, before + 1, `retried after ${wait} ms`);
  }
});

test("rejected credentials are not retried", async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, state, calls } = authFixture([new Error("200/26108 Email address or password incorrect")]);
  await ctx.login();
  assert.equal(state.timers.loginRetry, null);
  t.mock.timers.tick(LOGIN_RETRY_MS.at(-1) * 3);
  await settle();
  assert.equal(calls.login, 1);
});

test("a 2FA challenge stops the retries: the user has to answer it", async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, calls } = authFixture([
    new TypeError("fetch failed"),
    { status: LoginStatus.TwoFactor, method: "email" },
  ]);
  await ctx.login();
  t.mock.timers.tick(LOGIN_RETRY_MS[0]);
  await settle();
  assert.equal(ctx.authStatus().state, "require_2fa");
  t.mock.timers.tick(LOGIN_RETRY_MS.at(-1) * 3);
  await settle();
  assert.equal(calls.login, 2);
});

test("a login over the WS (auth.retrigger) cancels the pending retry", async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, state, calls } = authFixture([new TypeError("fetch failed")]);
  await ctx.login();
  assert.ok(state.timers.loginRetry);
  await ctx.applyLogin({ status: LoginStatus.Ok }); // what ws-server's auth.retrigger does
  assert.equal(state.timers.loginRetry, null);
  t.mock.timers.tick(LOGIN_RETRY_MS.at(-1));
  await settle();
  assert.equal(calls.login, 1);
});

test("a session recovery that fails on the network is retried too", async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, state, calls } = authFixture([new TypeError("fetch failed"), { status: LoginStatus.Ok }]);
  state.flags.ready = true;
  await ctx.onSessionExpired();
  assert.equal(ctx.authStatus().state, "reauth");
  t.mock.timers.tick(LOGIN_RETRY_MS[0]);
  await settle();
  assert.equal(calls.login, 2);
  assert.equal(ctx.authStatus().state, "ok");
});

test("without EUFY_LOGIN_RETRY a failed login waits for auth.retrigger, as upstream does", async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, state, calls } = authFixture([new TypeError("fetch failed")], { loginRetry: false });
  await ctx.login();
  assert.equal(state.timers.loginRetry, null);
  t.mock.timers.tick(LOGIN_RETRY_MS.at(-1) * 3);
  await settle();
  assert.equal(calls.login, 1);
  assert.equal(ctx.authStatus().state, "pending");
});

test("isCredentialError tells a rejected account from a network failure", () => {
  assert.equal(isCredentialError(new Error("200/26108 Email address or password incorrect")), true);
  assert.equal(isCredentialError(new TypeError("fetch failed")), false);
  assert.equal(isCredentialError(new Error("getaddrinfo EAI_AGAIN mysecurity.eufylife.com")), false);
});
