'use strict';

/**
 * Minimal client for the Google Health API v4.
 *
 * Endpoints (base https://health.googleapis.com/v4):
 *   GET  /users/me/dataTypes/{type}/dataPoints              — list (newest first)
 *   POST /users/me/dataTypes/{type}/dataPoints:dailyRollUp  — daily totals (civil days)
 *   POST /users/me/dataTypes/{type}/dataPoints              — create (writable types)
 *   GET  /users/me/identity | /users/me/settings            — user info
 *
 * OAuth 2.0 with per-user Google Cloud credentials. The redirect URI is
 * Homey's cloud callback, which must be registered on the user's OAuth client.
 */

const BASE_URL = 'https://health.googleapis.com/v4';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE_PREFIX = 'https://www.googleapis.com/auth/googlehealth.';

// Homey's OAuth2 callback proxy. Google exchanges require the same
// redirect_uri that was used in the authorization request.
const REDIRECT_URI = 'https://callback.athom.com/oauth2/callback';

class GoogleHealthApiError extends Error {

  constructor(message, { statusCode = null, code = null } = {}) {
    super(message);
    this.name = 'GoogleHealthApiError';
    this.statusCode = statusCode;
    this.code = code;
  }

}

class GoogleHealthApi {

  /**
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {string} opts.clientSecret
   * @param {object} opts.tokens - { accessToken, refreshToken, expiresAt }
   * @param {function} [opts.onTokensUpdated] - async callback invoked with new tokens
   * @param {function} [opts.log]
   */
  constructor({ clientId, clientSecret, tokens, onTokensUpdated, log }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokens = tokens || null;
    this.onTokensUpdated = onTokensUpdated || (async () => {});
    this.log = log || (() => {});
    this._refreshPromise = null;
  }

  static get REDIRECT_URI() {
    return REDIRECT_URI;
  }

  /**
   * Scopes for the app. The readonly scopes are always requested — the
   * read/write scope does not imply read access, so weight logging adds the
   * write scope on top instead of replacing the readonly one.
   */
  static scopes({ allowWrite = false } = {}) {
    const scopes = [
      `${SCOPE_PREFIX}activity_and_fitness.readonly`,
      `${SCOPE_PREFIX}health_metrics_and_measurements.readonly`,
      `${SCOPE_PREFIX}sleep.readonly`,
      `${SCOPE_PREFIX}nutrition.readonly`,
    ];
    if (allowWrite) {
      scopes.push(`${SCOPE_PREFIX}health_metrics_and_measurements`);
    }
    return scopes;
  }

  /**
   * Authorization URL. Homey's createOAuth2Callback only appends `state`, so the
   * redirect_uri must be part of the URL we build here — and it must exactly match
   * an "Authorized redirect URI" on the Google OAuth client.
   * access_type=offline + prompt=consent make Google return a refresh token.
   */
  static buildAuthUrl({ clientId, scopes }) {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  static async exchangeCode({ clientId, clientSecret, code }) {
    return GoogleHealthApi._tokenRequest({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
    });
  }

  static async _tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    let body = {};
    try {
      body = await res.json();
    } catch (err) {
      // Non-JSON error body, fall through to the status check below
    }

    if (!res.ok) {
      const description = body.error_description || body.error || `HTTP ${res.status}`;
      throw new GoogleHealthApiError(`Token request failed: ${description}`, {
        statusCode: res.status,
        code: body.error || null,
      });
    }

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || null,
      expiresAt: Date.now() + ((body.expires_in || 3600) * 1000),
      scope: body.scope || '',
    };
  }

  async _refreshTokens() {
    // Collapse concurrent refreshes into one request
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = (async () => {
      if (!this.tokens || !this.tokens.refreshToken) {
        throw new GoogleHealthApiError('Not authenticated: no refresh token. Please repair the device.', { code: 'no_refresh_token' });
      }
      const fresh = await GoogleHealthApi._tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });
      // Google usually omits the refresh token on refresh — keep the old one
      this.tokens = {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || this.tokens.refreshToken,
        expiresAt: fresh.expiresAt,
        scope: fresh.scope || this.tokens.scope || '',
      };
      await this.onTokensUpdated(this.tokens);
      return this.tokens;
    })();

    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async _ensureAccessToken() {
    if (!this.tokens || !this.tokens.accessToken) {
      throw new GoogleHealthApiError('Not authenticated. Please repair the device.', { code: 'not_authenticated' });
    }
    if (this.tokens.expiresAt && this.tokens.expiresAt - 60_000 < Date.now()) {
      await this._refreshTokens();
    }
    return this.tokens.accessToken;
  }

  async request(method, path, { query, body } = {}) {
    let token = await this._ensureAccessToken();

    const doFetch = async accessToken => {
      let url = BASE_URL + path;
      if (query) {
        const params = new URLSearchParams(query);
        url += `?${params.toString()}`;
      }
      return fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    };

    let res = await doFetch(token);

    // One retry after a forced refresh on auth failure
    if (res.status === 401) {
      token = (await this._refreshTokens()).accessToken;
      res = await doFetch(token);
    }

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        if (err.error && err.error.message) message = err.error.message;
      } catch (parseErr) {
        // Keep the generic HTTP status message
      }
      // 403 with a scope complaint means the user did not grant this
      // permission on Google's consent screen — callers skip that data type
      const isMissingScope = res.status === 403 && /scope/i.test(message);
      throw new GoogleHealthApiError(`Google Health API error: ${message}`, {
        statusCode: res.status,
        code: isMissingScope ? 'missing_scope' : null,
      });
    }

    if (res.status === 204) return {};
    return res.json();
  }

  /**
   * List data points, newest first.
   * @returns {Promise<Array>} raw dataPoints
   */
  async list(type, { filter, pageSize = 1 } = {}) {
    const query = { pageSize: String(pageSize) };
    if (filter) query.filter = filter;
    const res = await this.request('GET', `/users/me/dataTypes/${type}/dataPoints`, { query });
    return Array.isArray(res.dataPoints) ? res.dataPoints : [];
  }

  /**
   * Daily totals over civil days. from/to are inclusive 'YYYY-MM-DD' strings.
   * @returns {Promise<Array>} raw rollupDataPoints
   */
  async dailyRollup(type, fromDate, toDate) {
    const body = {
      range: {
        start: { date: GoogleHealthApi._civilDate(fromDate) },
        // The API range is closed-open, so advance the end by one day
        end: { date: GoogleHealthApi._civilDate(GoogleHealthApi._nextDay(toDate)) },
      },
      windowSizeDays: 1,
    };
    const res = await this.request('POST', `/users/me/dataTypes/${type}/dataPoints:dailyRollUp`, { body });
    return Array.isArray(res.rollupDataPoints) ? res.rollupDataPoints : [];
  }

  /** Create a data point (writable types: weight, body-fat, height, exercise, sleep). */
  async createDataPoint(type, payload) {
    return this.request('POST', `/users/me/dataTypes/${type}/dataPoints`, { body: payload });
  }

  async getIdentity() {
    return this.request('GET', '/users/me/identity');
  }

  async getUserSettings() {
    return this.request('GET', '/users/me/settings');
  }

  /**
   * Extract the type-specific value object from a raw (rollup) data point,
   * e.g. { countSum: "9037" } from { civilStartTime: …, steps: { countSum: "9037" } }.
   */
  static valueObject(point) {
    if (!point || typeof point !== 'object') return null;
    const timeKeys = new Set([
      'name', 'civilStartTime', 'civilEndTime', 'startTime', 'endTime',
      'dataSource', 'metadata', 'createTime', 'updateTime',
    ]);
    for (const [key, value] of Object.entries(point)) {
      if (!timeKeys.has(key) && value && typeof value === 'object') return value;
    }
    return null;
  }

  /**
   * Read a numeric field from a raw point's value object. int64 fields arrive
   * as strings per protobuf JSON encoding, so coerce defensively.
   */
  static numberField(point, field) {
    const values = GoogleHealthApi.valueObject(point);
    if (!values || values[field] === undefined || values[field] === null) return null;
    const num = Number(values[field]);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Read the first numeric field found on a raw point's value object: tries the
   * candidate names first, then falls back to scanning for any finite numeric
   * (or numeric-string) field. Useful for types whose exact field name is not
   * documented — int64 fields arrive as strings per protobuf JSON encoding.
   */
  static firstNumber(point, candidates = []) {
    const values = GoogleHealthApi.valueObject(point);
    if (!values) return null;
    for (const field of candidates) {
      if (values[field] !== undefined && values[field] !== null) {
        const num = Number(values[field]);
        if (Number.isFinite(num)) return num;
      }
    }
    const skip = new Set(['sampleTime', 'interval', 'date', 'createTime', 'updateTime', 'metadata']);
    for (const [key, value] of Object.entries(values)) {
      if (skip.has(key)) continue;
      if (typeof value === 'object') continue;
      const num = Number(value);
      if (Number.isFinite(num) && value !== '' && value !== true && value !== false) return num;
    }
    return null;
  }

  static _civilDate(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return { year, month, day };
  }

  static _nextDay(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day + 1));
    return d.toISOString().slice(0, 10);
  }

}

module.exports = GoogleHealthApi;
module.exports.GoogleHealthApiError = GoogleHealthApiError;
