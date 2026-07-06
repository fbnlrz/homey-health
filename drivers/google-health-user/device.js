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
    // Persistent (non-scope) failure tracking: after 3 consecutive failures a
    // type is surfaced as a device warning instead of freezing silently
    this._typeFailures = {};
    this._failing = new Set();
    this._apiDisabledMessage = null;

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

  _startPolling(minutesOverride) {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
    const configured = Number(minutesOverride) || Number(this.getSetting('poll_interval')) || 15;
    const minutes = Math.max(MIN_POLL_MINUTES, configured);
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
    this._failing.clear();
    this._typeFailures = {};
    this._apiDisabledMessage = null;
    await this._refreshWarning();
    this._createApi();
    await this.setAvailable().catch(this.error);
    this.sync().catch(this.error);
  }

  /** Flow action "Synchronize now". */
  async syncNow() {
    await this.sync();
  }

  async sync() {
    // Share the in-flight sync instead of silently no-opping, so the
    // "Synchronize now" flow action always resolves after a completed sync
    if (this._syncPromise) return this._syncPromise;
    this._syncPromise = this._doSync().finally(() => {
      this._syncPromise = null;
    });
    return this._syncPromise;
  }

  async _doSync() {
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
      if (err.statusCode === 401 || GoogleHealthDevice.AUTH_ERROR_CODES.has(err.code)) {
        await this.setUnavailable(this.homey.__('device.auth_lost')).catch(this.error);
      }
      throw err;
    }
  }

  static get AUTH_ERROR_CODES() {
    return new Set([
      'no_refresh_token', 'not_authenticated', 'invalid_grant',
      'invalid_client', 'unauthorized_client',
    ]);
  }

  /**
   * Wrap one data-type call: skip types whose scope the user did not grant,
   * remember new scope denials instead of retrying them every poll, and
   * surface types that keep failing as a device warning rather than letting
   * their values freeze silently.
   */
  async _guarded(type, fn) {
    if (this._scopeDenied.has(type)) return;
    try {
      await fn();
      this._typeFailures[type] = 0;
      let recovered = this._failing.delete(type);
      if (this._apiDisabledMessage) {
        this._apiDisabledMessage = null;
        recovered = true;
      }
      if (recovered) await this._refreshWarning();
    } catch (err) {
      if (err.code === 'missing_scope') {
        this._scopeDenied.add(type);
        this.error(`No OAuth scope for '${type}' — skipping until repair. Re-authorize and tick all permission checkboxes on the Google consent screen.`);
        await this._refreshWarning();
        return;
      }
      if (err.code === 'api_disabled') {
        this._apiDisabledMessage = err.message;
        this.error(`Google Health API disabled for this project: ${err.message}`);
        await this._refreshWarning();
        return;
      }
      this._rethrowIfAuth(err);
      this._typeFailures[type] = (this._typeFailures[type] || 0) + 1;
      if (this._typeFailures[type] >= 3 && !this._failing.has(type)) {
        this._failing.add(type);
        await this._refreshWarning();
      }
      this.error(`${type} sync failed:`, err.message);
    }
  }

  /** One warning slot — compose it from the current problem sets. */
  async _refreshWarning() {
    let warning = null;
    if (this._scopeDenied.size) {
      warning = this.homey.__('device.missing_scopes', { types: [...this._scopeDenied].join(', ') });
    } else if (this._apiDisabledMessage) {
      warning = this.homey.__('device.api_disabled');
    } else if (this._failing.size) {
      warning = this.homey.__('device.sync_failing', { types: [...this._failing].join(', ') });
    }
    if (warning) await this.setWarning(warning).catch(this.error);
    else await this.unsetWarning().catch(this.error);
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
      'measure_distance', 'measure_calories',
      'measure_active_calories', 'measure_floors',
      'measure_active_zone_minutes', 'measure_hydration',
    ];
    for (const capability of dailyCapabilities) {
      await this._setNumber(capability, 0);
    }
    // Route steps through _setSteps so the steps_updated trigger also fires
    // for the midnight N→0 transition (Flows mirroring the value stay in sync)
    await this._setSteps(today, 0);
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
        // A sync straddling midnight must not write yesterday's totals (or
        // fire the step goal) into the new day — the next poll re-fetches
        if (this._todayLocalDate() !== today) return;
        const value = points.length ? read(points[0]) : null;
        if (value !== null) await apply(value);
      });
    }

    await this._syncExercise();
  }

  // ── Exercise: workout_ended trigger + exercised_today bookkeeping ─

  async _syncExercise() {
    await this._guarded('exercise', async () => {
      const sessions = await this.api.list('exercise', { pageSize: 3 });
      if (!sessions.length) return;

      const newestData = sessions[0].exercise || GoogleHealthApi.valueObject(sessions[0]) || {};
      const newestEnd = newestData.interval ? newestData.interval.endTime : null;
      if (newestEnd) {
        await this.setStoreValue('last_exercise_end_date', this._localDateOf(newestEnd)).catch(this.error);
      }

      const seen = this.getStoreValue('seen_exercise_keys');
      const keys = sessions.map(s => s.name).filter(Boolean);
      if (!Array.isArray(seen)) {
        // First run: record without triggering, so historic workouts don't
        // flood the flows on install
        await this.setStoreValue('seen_exercise_keys', keys.slice(0, 10)).catch(this.error);
        return;
      }

      const fresh = sessions.filter(s => s.name && !seen.includes(s.name)).reverse();
      for (const session of fresh) {
        const data = session.exercise || GoogleHealthApi.valueObject(session) || {};
        const interval = data.interval || {};
        const metrics = data.metricsSummary || {};
        let duration = 0;
        if (interval.startTime && interval.endTime) {
          duration = Math.round((new Date(interval.endTime) - new Date(interval.startTime)) / 60000);
        }
        this.driver.workoutEndedTrigger
          .trigger(this, {
            activity_type: GoogleHealthDevice.prettyActivityType(data.type),
            duration_minutes: Number.isFinite(duration) ? duration : 0,
            calories: Math.round(Number(metrics.caloriesKcal) || 0),
            avg_heart_rate: Math.round(Number(metrics.averageHeartRateBeatsPerMinute) || 0),
          })
          .catch(this.error);
      }
      if (fresh.length) {
        const merged = [...keys, ...seen].filter((k, i, a) => a.indexOf(k) === i).slice(0, 10);
        await this.setStoreValue('seen_exercise_keys', merged).catch(this.error);
      }
    });
  }

  /** "STRENGTH_TRAINING" → "Strength Training" */
  static prettyActivityType(raw) {
    if (!raw || typeof raw !== 'string') return 'Workout';
    return raw.toLowerCase().split(/[_\s]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  async _setSteps(today, steps) {
    const previous = this.getCapabilityValue('measure_steps');
    await this._setNumber('measure_steps', steps);

    // Bookkeeping for the "steps increased recently" condition: only a real
    // increase counts — the midnight N→0 reset must not refresh it
    if (typeof previous === 'number' && steps > previous) {
      await this.setStoreValue('last_steps_increase_at', Date.now()).catch(this.error);
    }

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
      const previous = this.getCapabilityValue('measure_heart_rate');
      await this._setNumber('measure_heart_rate', bpm);
      if (changed) {
        await this.setStoreValue('last_hr_time', sampleTime).catch(this.error);
        this.driver.heartRateUpdatedTrigger
          .trigger(this, { heart_rate: bpm })
          .catch(this.error);
        if (typeof previous === 'number' && previous !== bpm) {
          this.driver.heartRateCrossedTrigger
            .trigger(this, { heart_rate: bpm }, { previous, current: bpm })
            .catch(this.error);
        }
      }
    });

    await this._guarded('daily-resting-heart-rate', async () => {
      // pageSize 8 = today + up to 7 prior days from the same request,
      // enough for the 7-day-average trigger without an extra call
      const points = await this.api.list('daily-resting-heart-rate', { pageSize: 8 });
      if (!points.length) return;
      const bpm = GoogleHealthApi.numberField(points[0], 'beatsPerMinute');
      if (bpm === null) return;
      await this._setNumber('measure_resting_heart_rate', bpm);

      const values = GoogleHealthApi.valueObject(points[0]) || {};
      const date = values.date
        ? `${values.date.year}-${String(values.date.month).padStart(2, '0')}-${String(values.date.day).padStart(2, '0')}`
        : null;
      if (!date || date === this.getStoreValue('last_rhr_date')) return;

      const history = points.slice(1)
        .map(p => GoogleHealthApi.numberField(p, 'beatsPerMinute'))
        .filter(v => v !== null);
      if (history.length >= 3) {
        const baseline = history.reduce((sum, v) => sum + v, 0) / history.length;
        const difference = Math.round((bpm - baseline) * 10) / 10;
        this.driver.restingHrElevatedTrigger
          .trigger(this, {
            resting_hr: bpm,
            baseline: Math.round(baseline * 10) / 10,
            difference,
          }, { difference })
          .catch(this.error);
      }
      await this.setStoreValue('last_rhr_date', date).catch(this.error);
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
      // Only write on a new data point: Google materializes logWeight() writes
      // asynchronously, so an unconditional write would revert a just-logged
      // value back to the previous reading until the API catches up
      if (changed || this.getCapabilityValue('measure_weight') === null) {
        await this._setNumber('measure_weight', kg);
      }
      if (changed) {
        await this.setStoreValue('last_weight_key', key).catch(this.error);
        this.driver.newWeightTrigger
          .trigger(this, { weight: kg })
          .catch(this.error);
      }
    });

    await this._guarded('oxygen-saturation', async () => {
      // Prefer the daily summary — that is what the Google Health app itself
      // shows. Raw spot samples can contain low-confidence garbage readings
      // (e.g. 50% because the sensor lost skin contact) that the app ignores.
      let pct = null;
      try {
        const daily = await this.api.list('daily-oxygen-saturation', { pageSize: 1 });
        if (daily.length) {
          const values = GoogleHealthApi.valueObject(daily[0]) || {};
          for (const key of ['averagePercentage', 'avgPercentage', 'meanPercentage', 'percentage', 'average', 'mean']) {
            const value = values[key];
            // some summary fields nest further, e.g. average: { percentage: 96 }
            const num = Number(value && typeof value === 'object' ? value.percentage : value);
            if (Number.isFinite(num)) {
              pct = num;
              break;
            }
          }
          if (pct === null) {
            this.log('daily-oxygen-saturation: unrecognized fields:', JSON.stringify(values).slice(0, 300));
          }
        }
      } catch (err) {
        this.error('daily SpO2 fetch failed, falling back to samples:', err.message);
      }

      if (pct === null) {
        const points = await this.api.list('oxygen-saturation', { pageSize: 1 });
        if (!points.length) return;
        pct = GoogleHealthApi.numberField(points[0], 'percentage');
        if (pct !== null && pct < 70) {
          // physiologically implausible spot reading — log the raw point for diagnosis
          this.log('Suspicious SpO2 sample:', JSON.stringify(points[0]).slice(0, 300));
        }
      }

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
      if (this._todayLocalDate() !== today) return;
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

      // Deep-sleep minutes for the deep_sleep_below condition (best effort —
      // some sources report totals only, without stages)
      const stages = sleep.summary.stagesSummary;
      if (Array.isArray(stages)) {
        const deep = stages.find(s => s && typeof s.type === 'string' && /deep/i.test(s.type));
        if (deep) {
          const deepMinutes = Number(deep.minutes);
          if (Number.isFinite(deepMinutes)) {
            await this.setStoreValue('last_deep_sleep_min', deepMinutes).catch(this.error);
          }
        }
      }

      if (changed) {
        await this.setStoreValue('last_sleep_key', key).catch(this.error);
        const tokens = { hours_asleep: hours, minutes_awake: minutesAwake };
        this.driver.sleepUpdatedTrigger
          .trigger(this, tokens)
          .catch(this.error);

        // "You woke up": only for sessions that ended within the last 4 hours,
        // so a backfilled historic sync doesn't fire morning routines at night
        const endTime = sleep.interval ? sleep.interval.endTime : null;
        if (endTime) {
          const ageMs = Date.now() - new Date(endTime).getTime();
          if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 4 * 60 * 60 * 1000) {
            this.driver.wokeUpTrigger
              .trigger(this, { ...tokens, wake_time: this._localTimeOf(endTime) })
              .catch(this.error);
          }
        }
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

  async logBodyFat(percentage) {
    const offsetSeconds = this._utcOffsetSeconds();
    await this.api.createDataPoint('body-fat', {
      bodyFat: {
        percentage,
        sampleTime: {
          physicalTime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          utcOffset: `${offsetSeconds}s`,
        },
      },
    });
    await this._setNumber('measure_body_fat', Math.round(percentage * 10) / 10);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  async _setNumber(capability, value) {
    if (!this.hasCapability(capability)) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  _rethrowIfAuth(err) {
    if (err && (err.statusCode === 401 || GoogleHealthDevice.AUTH_ERROR_CODES.has(err.code))) {
      throw err;
    }
  }

  /** Today's date (YYYY-MM-DD) in Homey's local timezone. */
  _todayLocalDate() {
    return this._localDateOf(new Date());
  }

  /** Date (YYYY-MM-DD) of an instant in Homey's local timezone. */
  _localDateOf(instant) {
    const timezone = this.homey.clock.getTimezone();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return formatter.format(instant instanceof Date ? instant : new Date(instant));
  }

  /** Time (HH:mm) of an instant in Homey's local timezone. */
  _localTimeOf(instant) {
    const timezone = this.homey.clock.getTimezone();
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(instant instanceof Date ? instant : new Date(instant));
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

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      // getSetting() still returns the OLD value inside onSettings (settings
      // persist only after this resolves) — pass the fresh value explicitly
      this._startPolling(newSettings.poll_interval);
    }
    // Apply new data-group selections right away (after settings persisted)
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
