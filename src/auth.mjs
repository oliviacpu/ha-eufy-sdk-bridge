// Auth + session lifecycle, driven over the WS. If eufy demands 2FA/captcha the bridge does NOT exit —
// it surfaces the need and lets the frontend answer. A cloud token kicked/expired AFTER boot is treated
// as a first-class state (`reauth`) so HA stops trusting stale poll data, and re-login is attempted in
// place. Reads cross-module functions (broadcast, completeBoot) off `ctx` at call time.
import { LoginStatus } from "@mega-yfue/eufy-sdk";

// With EUFY_LOGIN_RETRY on, the waits between login attempts after a failure no user can answer (the network
// isn't up yet at boot, eufy's cloud is briefly down): quick at first, since the usual cause is a host boot that
// beat the network, then every 5 minutes for as long as it takes. A 2FA/captcha challenge or rejected
// credentials stop the retries.
export const LOGIN_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

// eufy answers a wrong country with the same `200/26108 Email address or password incorrect`
// it uses for a genuinely wrong password, which sends people to debug the one thing that isn't
// wrong (#60). The upstream code doesn't separate the two cases, so don't pretend to — just
// name the other candidate, since it is the one nobody thinks of.
const COUNTRY_HINT =
  " (if the credentials are definitely right, check EUFY_COUNTRY: it must be the country the" +
  " account was registered in)";

/** eufy rejected the account itself: retrying would only repeat the rejection (and risk a lockout). */
export function isCredentialError(e) {
  return /26108|password incorrect/i.test(String(e?.message ?? e));
}

export function createAuth(ctx) {
  const { eufy } = ctx;
  const { flags, timers } = ctx.state;
  let retryStreak = 0; // failed attempts in a row, picks the next LOGIN_RETRY_MS wait

  /** The normalized auth state a frontend reads — one shape for auth.status, the `auth` event and /healthz. */
  function authStatus() {
    // A post-boot session loss outranks `ready`: surface the re-auth need so HA stops trusting stale state.
    if (flags.sessionLost) {
      if (flags.lastLogin?.status === LoginStatus.Captcha) {
        return { state: "require_captcha", image: flags.lastLogin.image, retry: flags.lastLogin.retry };
      }
      if (flags.lastLogin?.status === LoginStatus.TwoFactor) {
        return { state: "require_2fa", method: flags.lastLogin.method };
      }
      return { state: "reauth" }; // kicked; automatic re-login in progress or just failed
    }
    if (flags.ready) return { state: "ok" };
    if (flags.lastLogin?.status === LoginStatus.Captcha) {
      return { state: "require_captcha", image: flags.lastLogin.image, retry: flags.lastLogin.retry };
    }
    if (flags.lastLogin?.status === LoginStatus.TwoFactor) {
      return { state: "require_2fa", method: flags.lastLogin.method };
    }
    return { state: "pending" };
  }

  /** Apply a LoginResult: complete the boot on success, and always tell every client the new auth state. */
  async function applyLogin(result) {
    flags.lastLogin = result;
    if (result.status === LoginStatus.Ok) {
      cancelLoginRetry(); // a WS auth.retrigger may beat a pending retry
      eufy.forgetDevices?.(); // a fresh session rebinds command sinks: rebuild devices on next use
      await ctx.completeBoot(); // no-op once `ready` (first boot only), so re-auth never re-wires listeners
      if (flags.sessionLost) {
        // Recovered from a post-boot expiry: clear the flag and re-arm the poll under the fresh epoch.
        flags.sessionLost = false;
        eufy.setPollInterval(eufy.pollIntervalMs);
        flags.pushSince = Date.now();
      }
    }
    ctx.broadcast({ event: "auth", ...authStatus() });
  }

  function cancelLoginRetry() {
    if (timers.loginRetry) clearTimeout(timers.loginRetry);
    timers.loginRetry = null;
    retryStreak = 0;
  }

  /** Still worth logging in on our own: not logged in (or kicked), and eufy isn't waiting on the user. */
  function loginWanted() {
    const status = flags.lastLogin?.status;
    const needsUser = status === LoginStatus.Captcha || status === LoginStatus.TwoFactor;
    return (!flags.ready || flags.sessionLost) && !needsUser;
  }

  /** After a failed login: with EUFY_LOGIN_RETRY on, anything but rejected credentials is tried again later. */
  function onLoginFailure(label, err) {
    const msg = String(err?.message ?? err);
    if (isCredentialError(err) || !ctx.cfg?.loginRetry) {
      cancelLoginRetry();
      const hint = isCredentialError(err) ? COUNTRY_HINT : "";
      console.error(`[bridge] ${label} failed: ${msg}${hint} — retry via WS 'auth.retrigger'`);
      return;
    }
    const wait = LOGIN_RETRY_MS[Math.min(retryStreak, LOGIN_RETRY_MS.length - 1)];
    retryStreak += 1;
    console.error(`[bridge] ${label} failed: ${msg} — trying again in ${Math.round(wait / 1000)} s`);
    if (timers.loginRetry) clearTimeout(timers.loginRetry);
    timers.loginRetry = setTimeout(() => {
      timers.loginRetry = null;
      if (loginWanted()) void login(label);
    }, wait);
    timers.loginRetry.unref?.();
  }

  /**
   * Log in and apply the result; a failure goes to onLoginFailure. Without EUFY_LOGIN_RETRY the boot login runs
   * once (upstream's behaviour), so a host boot that beats the network leaves the bridge `pending` until a
   * frontend sends auth.retrigger.
   */
  async function login(label = "login attempt") {
    // After boot, a re-login holds the same guard onSessionExpired does, so the push watchdog can't disconnect
    // and log in underneath it. If a recovery is already running, leave it to that one.
    const afterBoot = flags.ready;
    if (afterBoot && flags.recovering) return;
    if (afterBoot) flags.recovering = true;
    try {
      await applyLogin(await eufy.login());
    } catch (err) {
      onLoginFailure(label, err);
    } finally {
      if (afterBoot) flags.recovering = false;
    }
  }

  /** Guarded entry: kick off a single re-auth after a post-boot session loss. */
  function maybeRecoverSession() {
    if (flags.ready && !flags.sessionLost && !flags.recovering) void onSessionExpired();
  }

  /**
   * The cloud token was kicked/invalidated after boot. Surface the loss to HA at once (so it stops
   * trusting stale poll data), then try to re-login in place. A fresh login usually needs 2FA — that is
   * broadcast as `require_2fa`, so HA can drive the re-auth immediately.
   */
  async function onSessionExpired() {
    flags.sessionLost = true;
    flags.recovering = true; // also blocks push recovery from racing this
    ctx.broadcast({ event: "auth", ...authStatus() });
    console.error("[bridge] cloud session expired (kicked/invalid) — re-authenticating");
    try {
      await eufy.disconnect().catch(() => {});
      await applyLogin(await eufy.login()); // Ok → clears sessionLost + re-arms; else → surfaces require_2fa
      if (flags.sessionLost)
        console.error(`[bridge] re-login needs user action (${flags.lastLogin?.status}) — drive auth.submit`);
      else console.log("[bridge] cloud session re-established after expiry");
    } catch (err) {
      ctx.broadcast({ event: "auth", ...authStatus() });
      onLoginFailure("session recovery", err);
    } finally {
      flags.recovering = false;
    }
  }

  return { authStatus, applyLogin, login, cancelLoginRetry, maybeRecoverSession, onSessionExpired };
}
