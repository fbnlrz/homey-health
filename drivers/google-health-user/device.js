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
    // Neutralize the old client first: a refresh that is mid-flight on the
    // old token lineage must not overwrite the repaired tokens in the store
    if (this.api) this.api.onTokensUpdated = async () => {};
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
      await this._resetDailyCountersIfNewDay(today);

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
      if (this.getSetting('sync_nutrition') !== false) {
        await this._syncNutrition(today);
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

  // ── Daily counters: restart at 0 when the local day changes ──────

  async _resetDailyCountersIfNewDay(today) {
    const lastDate = this.getStoreValue('daily_date');
    if (lastDate === today) return;
    await this.setStoreValue('daily_date', today).catch(this.error);
    if (!lastDate) return; // first sync ever — nothing to reset

    // "No data yet today" is rendered as 0-so-far; real values arrive with
    // the next rollup that has data (a missing rollup day means "not synced",
    // so we never overwrite a fresh value with 0 later in the day).
    const dailyCapabilities = [
      'measure_steps', 'measure_distance', 'measure_calories',
      'measure_active_calories', 'measure_floors',
      'measure_active_zone_minutes', 'measure_hydration',
    ];
    for (const capability of dailyCapabilities) {
      await this._setNumber(capability, 0);
    }
  }

  // ── Activity: daily rollups for today ────────────────────────────

  async _syncActivity(today) {
    const rollups = [
      { type: 'steps', read: p => GoogleHealthApi.numberField(p, 'countSum'), apply: v => this._setSteps(today, v) },
      { type: 'distance', read: p => GoogleHealthApi.numberField(p, 'millimetersSum'), apply: v => this._setNumber('measure_distance', Math.round(v / 10000) / 100) },
      { type: 'total-calories', read: p => GoogleHealthApi.numberField(p, 'kcalSum'), apply: v => this._setNumber('measure_calories', Math.round(v)) },
      { type: 'active-energy-burned', read: p => GoogleHealthApi.numberField(p, 'kcalSum'), apply: v => this._setNumber('measure_active_calories', Math.round(v)) },
      { type: 'floors', read: p => GoogleHealthApi.numberField(p, 'countSum'), apply: v => this._setNumber('measure_floors', v) },
      { type: 'active-zone-minutes', read: p => GoogleHealthApi.firstNumber(p, ['activeZoneMinutesSum', 'activeZoneMinutes', 'minutesSum']), apply: v => this._setNumber('measure_active_zone_minutes', Math.round(v)) },
    ];

    for (const { type, read, apply } of rollups) {
      await this._guarded(type, async () => {
        const points = await this.api.dailyRollup(type, today, today);
        const value = points.length ? read(points[0]) : null;
        if (value !== null) await apply(value);
      });
    }
  }

  async _setSteps(today, steps) {
    const previous = this.getCapabilityValue('measure_steps');
    await this._setNumber('measure_steps', steps);

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

    await this._guarded('daily-heart-rate-variability', async () => {
      const points = await this.api.list('daily-heart-rate-variability', { pageSize: 1 });
      if (!points.length) return;
      const ms = GoogleHealthApi.firstNumber(points[0], ['rmssd', 'rmssdMilliseconds', 'dailyRmssd']);
      if (ms !== null) await this._setNumber('measure_hrv', Math.round(ms));
    });

    await this._guarded('daily-vo2-max', async () => {
      const points = await this.api.list('daily-vo2-max', { pageSize: 1 });
      if (!points.length) return;
      const vo2 = GoogleHealthApi.firstNumber(points[0], ['vo2Max', 'value']);
      if (vo2 !== null) await this._setNumber('measure_vo2_max', Math.round(vo2 * 10) / 10);
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

    await this._guarded('body-fat', async () => {
      const points = await this.api.list('body-fat', { pageSize: 1 });
      if (!points.length) return;
      const pct = GoogleHealthApi.numberField(points[0], 'percentage');
      if (pct !== null) await this._setNumber('measure_body_fat', Math.round(pct * 10) / 10);
    });

    await this._guarded('daily-respiratory-rate', async () => {
      const points = await this.api.list('daily-respiratory-rate', { pageSize: 1 });
      if (!points.length) return;
      const rate = GoogleHealthApi.firstNumber(points[0], ['breathsPerMinute', 'respiratoryRate', 'value']);
      if (rate !== null) await this._setNumber('measure_respiratory_rate', Math.round(rate * 10) / 10);
    });
  }

  // ── Nutrition: water intake today ─────────────────────────────────

  async _syncNutrition(today) {
    await this._guarded('hydration-log', async () => {
      const points = await this.api.dailyRollup('hydration-log', today, today);
      if (!points.length) return;
      const ml = GoogleHealthApi.firstNumber(points[0], ['millilitersSum', 'milliliters']);
      if (ml !== null) await this._setNumber('measure_hydration', Math.round(ml));
    });
  }

  // ── Sleep: most recent session summary ────────────────────────────

  async _syncSleep() {
    await this._guarded('sleep', async () => {
      // Fetch a few sessions and use the newest non-nap one, so an afternoon
      // nap doesn't overwrite "Sleep last night" (nap flag: sleep.metadata.nap)
      const points = await this.api.list('sleep', { pageSize: 5 });
      const night = points.find(p => {
        const s = p.sleep || GoogleHealthApi.valueObject(p);
        return s && !(s.metadata && s.metadata.nap);
      });
      if (!night) return;

      const sleep = night.sleep || GoogleHealthApi.valueObject(night);
      if (!sleep || !sleep.summary) return;

      const minutesAsleep = Number(sleep.summary.minutesAsleep);
      const minutesAwake = Number(sleep.summary.minutesAwake) || 0;
      if (!Number.isFinite(minutesAsleep)) return;

      const hours = Math.round((minutesAsleep / 60) * 10) / 10;
      const key = night.name
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
    // Derive the offset from Intl's longOffset ("GMT+02:00") — deterministic,
    // unlike round-tripping toLocaleString output through Date parsing
    const timezone = this.homey.clock.getTimezone();
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, timeZoneName: 'longOffset',
      }).formatToParts(new Date());
      const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT';
      const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
      if (!match) return 0; // plain "GMT" = UTC
      const sign = match[1] === '-' ? -1 : 1;
      return sign * ((Number(match[2]) * 3600) + (Number(match[3]) * 60));
    } catch (err) {
      this.error('Could not determine UTC offset:', err.message);
      return 0;
    }
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
