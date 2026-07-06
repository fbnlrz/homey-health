'use strict';

const { createServer } = require('http');
const crypto = require('crypto');
const Homey = require('homey');

// The settings page runs in a sandboxed iframe where window.open, print and
// downloads are all blocked. To get the report out, the app serves it over
// the LAN for a short time and the page opens it via Homey.openURL().
// Hardening: every report gets a fresh server (fresh random port), a fresh
// URL token AND a fresh Basic-Auth password; everything shuts down after 5
// minutes.
const REPORT_TTL_MS = 5 * 60 * 1000;
const REPORT_MAX_BYTES = 2 * 1024 * 1024;
// Unambiguous characters only (no 0/O, 1/l/I) — the user has to type this
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKMNPQRSTUVWXYZ23456789';

class GoogleHealthApp extends Homey.App {

  async onInit() {
    this.homey.flow.getConditionCard('steps_above')
      .registerRunListener(async args => {
        const value = args.device.getCapabilityValue('measure_steps');
        return typeof value === 'number' && value > args.count;
      });

    this.homey.flow.getConditionCard('resting_hr_above')
      .registerRunListener(async args => {
        const value = args.device.getCapabilityValue('measure_resting_heart_rate');
        return typeof value === 'number' && value > args.bpm;
      });

    this.homey.flow.getConditionCard('slept_less_than')
      .registerRunListener(async args => {
        const hours = args.device.getCapabilityValue('measure_sleep_hours');
        return typeof hours === 'number' && hours < args.hours;
      });

    this.homey.flow.getConditionCard('deep_sleep_below')
      .registerRunListener(async args => {
        const minutes = args.device.getStoreValue('last_deep_sleep_min');
        return typeof minutes === 'number' && minutes < args.minutes;
      });

    this.homey.flow.getConditionCard('hydration_below')
      .registerRunListener(async args => {
        // No log yet today deliberately counts as "below" — that is the nudge
        const ml = args.device.getCapabilityValue('measure_hydration');
        return (typeof ml === 'number' ? ml : 0) < args.milliliters;
      });

    this.homey.flow.getConditionCard('active_zone_minutes_above')
      .registerRunListener(async args => {
        const minutes = args.device.getCapabilityValue('measure_active_zone_minutes');
        return (typeof minutes === 'number' ? minutes : 0) > args.minutes;
      });

    this.homey.flow.getConditionCard('steps_increased_recently')
      .registerRunListener(async args => {
        const timestamp = args.device.getStoreValue('last_steps_increase_at');
        return typeof timestamp === 'number'
          && (Date.now() - timestamp) < args.minutes * 60 * 1000;
      });

    this.homey.flow.getConditionCard('is_asleep')
      .registerRunListener(async args => {
        return args.device.getCapabilityValue('alarm_asleep') === true;
      });

    this.homey.flow.getConditionCard('exercised_today')
      .registerRunListener(async args => {
        const lastDate = args.device.getStoreValue('last_exercise_end_date');
        return !!lastDate && lastDate === args.device._todayLocalDate();
      });

    this.homey.flow.getActionCard('mark_asleep')
      .registerRunListener(async args => {
        await args.device.markAsleep();
      });

    this.homey.flow.getActionCard('mark_awake')
      .registerRunListener(async args => {
        await args.device.markAwake();
      });

    this.homey.flow.getActionCard('sync_now')
      .registerRunListener(async args => {
        await args.device.syncNow();
      });

    this.homey.flow.getActionCard('log_weight')
      .registerRunListener(async args => {
        await args.device.logWeight(args.weight);
      });

    this.homey.flow.getActionCard('log_body_fat')
      .registerRunListener(async args => {
        await args.device.logBodyFat(args.percentage);
      });

    this.log('Google Health app has been initialized');
  }

  /**
   * Host the generated report on the local network for REPORT_TTL_MS and
   * return { url, password, ttlMinutes }. Every call tears the previous
   * server down and starts a fresh one: new random port, new URL token,
   * new Basic-Auth password.
   */
  async publishReport(html) {
    if (typeof html !== 'string' || !html.length || html.length > REPORT_MAX_BYTES) {
      throw new Error('Invalid report payload');
    }

    this._stopReportServer();
    this._reportHtml = html;
    this._reportToken = crypto.randomBytes(16).toString('hex');
    this._reportPassword = GoogleHealthApp._generatePassword(8);

    const server = createServer((req, res) => {
      // Basic auth first, so an unauthenticated caller learns nothing —
      // not even whether the token path exists
      if (!this._checkReportAuth(req.headers.authorization)) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Health Report"',
          'Content-Type': 'text/plain',
        });
        res.end('Authentication required');
        return;
      }
      if (this._reportHtml && req.method === 'GET' && req.url === `/report/${this._reportToken}`) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(this._reportHtml);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, resolve);
    });
    this._reportServer = server;

    this._reportTimer = this.homey.setTimeout(() => this._stopReportServer(), REPORT_TTL_MS);

    const localAddress = await this.homey.cloud.getLocalAddress(); // e.g. "192.168.1.5:80"
    const host = String(localAddress).split(':')[0];
    const { port } = server.address();
    return {
      url: `http://${host}:${port}/report/${this._reportToken}`,
      password: this._reportPassword,
      ttlMinutes: Math.round(REPORT_TTL_MS / 60000),
    };
  }

  _checkReportAuth(authorizationHeader) {
    if (!this._reportPassword) return false;
    const header = String(authorizationHeader || '');
    if (!header.startsWith('Basic ')) return false;
    let decoded;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch (err) {
      return false;
    }
    // Any username is accepted — only the password counts
    const password = decoded.slice(decoded.indexOf(':') + 1);
    const given = crypto.createHash('sha256').update(password).digest();
    const expected = crypto.createHash('sha256').update(this._reportPassword).digest();
    return crypto.timingSafeEqual(given, expected);
  }

  static _generatePassword(length) {
    const bytes = crypto.randomBytes(length);
    let password = '';
    for (let i = 0; i < length; i++) {
      password += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    }
    return password;
  }

  _stopReportServer() {
    if (this._reportTimer) {
      this.homey.clearTimeout(this._reportTimer);
      this._reportTimer = null;
    }
    if (this._reportServer) {
      this._reportServer.close();
      this._reportServer = null;
    }
    this._reportHtml = null;
    this._reportToken = null;
    this._reportPassword = null;
  }

  async onUninit() {
    this._stopReportServer();
  }

}

module.exports = GoogleHealthApp;
