'use strict';

const Homey = require('homey');
const GoogleHealthApi = require('../../lib/GoogleHealthApi');

const MIN_POLL_MINUTES = 5;

class GoogleHealthDevice extends Homey.Device {

  async onInit() {
    // Add capabilities introduced after the device was paired
    for (const capability of this.driver.manifest.capabilities) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch(this.error);
      }
    }

    // Data types the user's Google consent does not cover — detected via 403s,
    // skipped until the next repair/restart so every poll isn't error spam
    this._scopeDenied = new Set();

    this._createApi();
    this._startPolling();

    // First sync shortly after startup, without blocking onInit
    this.homey.setTimeout(() => {
      this.sync().catch(this.error);
    }, 2000);

    this.log('GoogleHealthDevice has been initialized');
  }

  _createApi() {
    const { clientId, clientSecret } = this.driver.getOAuthConfig();
    this.api = new GoogleHealthApi({
      clientId,
      clientSecret,
      tokens: this.getStoreValue('tokens'),
      onTokensUpdated: async tokens => {
        await this.setStoreValue('tokens', tokens).catch(this.error);
      },
      log: (...args) => this.log(...args),
    });
  }

  _startPolling() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
    const minutes = Math.max(MIN_POLL_MINUTES, Number(this.getSetting('poll_interval')) || 15);
    this._pollInterval = this.homey.setInterval(() => {
      this.sync().catch(this.error);
    }, minutes * 60 * 1000);
  }

  /** Called from the repair flow with freshly exchanged tokens. */
  async onTokensRepaired(tokens) {
    await this.setStoreValue('tokens', tokens);
    this._scopeDenied.clear();
    await this.unsetWarning().catch(this.error);
    this._createApi();
    await this.setAvailable().catch(this.error);
    this.sync().catch(this.error);
  }

  /** Flow action "Synchronize now". */
  async syncNow() {
    await this.sync();
  }

  async sync() {
    if (this._syncing) return;
    this._syncing = true;

    try {
      const today = this._todayLocalDate();

      if (this.getSetting('sync_activity') !== false) {
        await this._syncActivity(today);
      }
      if (this.getSetting('sync_heart') !== false) {
        await this._syncHeart();
      }
      if (this.getSetting('sync_body') !== false) {
        await this._syncBody();
      }
      if (this.getSetting('sync_sleep') !== false) {
        await this._syncSleep();
      }

      await this.setAvailable().catch(this.error);
    } catch (err) {
      this.error('Sync failed:', err.message || err);
      if (err.statusCode === 401
        || err.code === 'no_refresh_token' || err.code === 'not_authenticated'
        || err.code === 'invalid_grant') {
        await this.setUnavailable(this.homey.__('device.auth_lost')).catch(this.error);
      }
      throw err;
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Wrap one data-type call: skip types whose scope the user did not grant,
   * and remember new scope denials instead of retrying them every poll.
   */
  async _guarded(type, fn) {
    if (this._scopeDenied.has(type)) return;
    try {
      await fn();
    } catch (err) {
      if (err.code === 'missing_scope') {
        this._scopeDenied.add(type);
        this.error(`No OAuth scope for '${type}' — skipping until repair. Re-authorize and tick all permission checkboxes on the Google consent screen.`);
        this.setWarning(this.homey.__('device.missing_scopes', {
          types: [...this._scopeDenied].join(', '),
        })).catch(this.error);
        return;
      }
      this._rethrowIfAuth(err);
      this.error(`${type} sync failed:`, err.message);
    }
  }

  // ── Activity: daily rollups for today ────────────────────────────

  async _syncActivity(today) {
    const rollups = [
      { type: 'steps', field: 'countSum', apply: v => this._setSteps(today, v) },
      { type: 'distance', field: 'millimetersSum', apply: v => this._setNumber('measure_distance', Math.round(v / 10000) / 100) },
      { type: 'total-calories', field: 'kcalSum', apply: v => this._setNumber('measure_calories', Math.round(v)) },
      { type: 'floors', field: 'countSum', apply: v => this._setNumber('measure_floors', v) },
    ];

    for (const { type, field, apply } of rollups) {
      await this._guarded(type, async () => {
        const points = await this.api.dailyRollup(type, today, today);
        const value = points.length ? GoogleHealthApi.numberField(points[0], field) : null;
        if (value !== null) {
          await apply(value);
        } else {
          // No data for today (yet). A daily counter should restart at 0 on a
          // new day rather than keep showing yesterday's total.
          await this._resetDailyIfNewDay(type, today);
        }
      });
    }
  }

  async _setSteps(today, steps) {
    const previous = this.getCapabilityValue('measure_steps');
    await this._setNumber('measure_steps', steps);
    await this.setStoreValue('steps_date', today).catch(this.error);

    if (previous !== steps) {
      this.driver.stepsUpdatedTrigger
        .trigger(this, { steps })
        .catch(this.error);
    }

    const goal = Number(this.getSetting('step_goal')) || 10000;
    const goalDate = this.getStoreValue('goal_date');
    if (steps >= goal && goalDate !== today) {
      await this.setStoreValue('goal_date', today).catch(this.error);
      this.driver.stepGoalReachedTrigger
        .trigger(this, { steps, goal })
        .catch(this.error);
    }
  }

  async _resetDailyIfNewDay(type, today) {
    if (type !== 'steps') return;
    const lastDate = this.getStoreValue('steps_date');
    if (lastDate && lastDate !== today) {
      await this._setNumber('measure_steps', 0);
      await this.setStoreValue('steps_date', today).catch(this.error);
    }
  }

  // ── Heart: latest reading + latest daily resting HR ──────────────

  async _syncHeart() {
    await this._guarded('heart-rate', async () => {
      const points = await this.api.list('heart-rate', { pageSize: 1 });
      if (!points.length) return;
      const bpm = GoogleHealthApi.numberField(points[0], 'beatsPerMinute');
      const values = GoogleHealthApi.valueObject(points[0]);
      const sampleTime = values && values.sampleTime ? values.sampleTime.physicalTime : null;
      if (bpm === null) return;
      const changed = sampleTime && sampleTime !== this.getStoreValue('last_hr_time');
      await this._setNumber('measure_heart_rate', bpm);
      if (changed) {
        await this.setStoreValue('last_hr_time', sampleTime).catch(this.error);
        this.driver.heartRateUpdatedTrigger
          .trigger(this, { heart_rate: bpm })
          .catch(this.error);
      }
    });

    await this._guarded('daily-resting-heart-rate', async () => {
      const points = await this.api.list('daily-resting-heart-rate', { pageSize: 1 });
      if (!points.length) return;
      const bpm = GoogleHealthApi.numberField(points[0], 'beatsPerMinute');
      if (bpm !== null) await this._setNumber('measure_resting_heart_rate', bpm);
    });
  }

  // ── Body: latest weight + latest SpO2 ─────────────────────────────

  async _syncBody() {
    await this._guarded('weight', async () => {
      const points = await this.api.list('weight', { pageSize: 1 });
      if (!points.length) return;
      const grams = GoogleHealthApi.numberField(points[0], 'weightGrams');
      if (grams === null) return;
      const kg = Math.round(grams / 100) / 10;
      const values = GoogleHealthApi.valueObject(points[0]) || {};
      const key = points[0].name || (values.sampleTime || {}).physicalTime;
      const changed = key && key !== this.getStoreValue('last_weight_key');
      await this._setNumber('measure_weight', kg);
      if (changed) {
        await this.setStoreValue('last_weight_key', key).catch(this.error);
        this.driver.newWeightTrigger
          .trigger(this, { weight: kg })
          .catch(this.error);
      }
    });

    await this._guarded('oxygen-saturation', async () => {
      const points = await this.api.list('oxygen-saturation', { pageSize: 1 });
      if (!points.length) return;
      const pct = GoogleHealthApi.numberField(points[0], 'percentage');
      if (pct !== null) await this._setNumber('measure_spo2', Math.round(pct));
    });
  }

  // ── Sleep: most recent session summary ────────────────────────────

  async _syncSleep() {
    await this._guarded('sleep', async () => {
      const points = await this.api.list('sleep', { pageSize: 1 });
      if (!points.length) return;

      const sleep = points[0].sleep || GoogleHealthApi.valueObject(points[0]);
      if (!sleep || !sleep.summary) return;

      const minutesAsleep = Number(sleep.summary.minutesAsleep);
      const minutesAwake = Number(sleep.summary.minutesAwake) || 0;
      if (!Number.isFinite(minutesAsleep)) return;

      const hours = Math.round((minutesAsleep / 60) * 10) / 10;
      const key = points[0].name
        || (sleep.interval ? sleep.interval.endTime : null);
      const changed = key && key !== this.getStoreValue('last_sleep_key');

      await this._setNumber('measure_sleep_hours', hours);
      if (changed) {
        await this.setStoreValue('last_sleep_key', key).catch(this.error);
        this.driver.sleepUpdatedTrigger
          .trigger(this, { hours_asleep: hours, minutes_awake: minutesAwake })
          .catch(this.error);
      }
    });
  }

  // ── Flow action: log weight to Google Health ─────────────────────

  async logWeight(kg) {
    const offsetSeconds = this._utcOffsetSeconds();
    await this.api.createDataPoint('weight', {
      weight: {
        weightGrams: Math.round(kg * 1000),
        sampleTime: {
          physicalTime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          utcOffset: `${offsetSeconds}s`,
        },
      },
    });
    // Writes are async on Google's side; reflect the value locally right away
    await this._setNumber('measure_weight', Math.round(kg * 10) / 10);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  async _setNumber(capability, value) {
    if (!this.hasCapability(capability)) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  _rethrowIfAuth(err) {
    if (err && (err.statusCode === 401 || err.code === 'no_refresh_token'
      || err.code === 'not_authenticated' || err.code === 'invalid_grant')) {
      throw err;
    }
  }

  /** Today's date (YYYY-MM-DD) in Homey's local timezone. */
  _todayLocalDate() {
    const timezone = this.homey.clock.getTimezone();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return formatter.format(new Date());
  }

  _utcOffsetSeconds() {
    const timezone = this.homey.clock.getTimezone();
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((local - utc) / 1000);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this._startPolling();
    }
    // Apply new data-group selections right away
    this.homey.setTimeout(() => {
      this.sync().catch(this.error);
    }, 1000);
  }

  async onDeleted() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
    this.log('GoogleHealthDevice has been deleted');
  }

  async onUninit() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
  }

}

module.exports = GoogleHealthDevice;
