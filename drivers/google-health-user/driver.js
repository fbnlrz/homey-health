'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const GoogleHealthApi = require('../../lib/GoogleHealthApi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class GoogleHealthDriver extends Homey.Driver {

  async onInit() {
    // Device trigger cards, fired from device.js
    this.stepsUpdatedTrigger = this.homey.flow.getDeviceTriggerCard('steps_updated');
    this.stepGoalReachedTrigger = this.homey.flow.getDeviceTriggerCard('step_goal_reached');
    this.heartRateUpdatedTrigger = this.homey.flow.getDeviceTriggerCard('heart_rate_updated');
    this.newWeightTrigger = this.homey.flow.getDeviceTriggerCard('new_weight_measurement');
    this.sleepUpdatedTrigger = this.homey.flow.getDeviceTriggerCard('sleep_updated');
    this.wokeUpTrigger = this.homey.flow.getDeviceTriggerCard('woke_up');
    this.workoutEndedTrigger = this.homey.flow.getDeviceTriggerCard('workout_ended');
    this.newGlucoseTrigger = this.homey.flow.getDeviceTriggerCard('new_glucose_measurement');
    this.ecgRecordedTrigger = this.homey.flow.getDeviceTriggerCard('ecg_recorded');
    this.irregularRhythmTrigger = this.homey.flow.getDeviceTriggerCard('irregular_rhythm_detected');

    // Threshold-crossing trigger: state carries {previous, current}
    this.heartRateCrossedTrigger = this.homey.flow.getDeviceTriggerCard('heart_rate_crossed')
      .registerRunListener(async (args, state) => {
        if (typeof state.previous !== 'number' || typeof state.current !== 'number') return false;
        return args.direction === 'above'
          ? state.previous <= args.bpm && state.current > args.bpm
          : state.previous >= args.bpm && state.current < args.bpm;
      });

    // Fires once per new daily value; each flow filters by its own delta
    this.restingHrElevatedTrigger = this.homey.flow.getDeviceTriggerCard('resting_hr_elevated')
      .registerRunListener(async (args, state) => {
        return typeof state.difference === 'number' && state.difference > args.delta;
      });

    // Pick up rotated OAuth credentials without an app restart
    this._onAppSettingsChanged = key => {
      if (key === 'client_id' || key === 'client_secret') {
        for (const device of this.getDevices()) {
          if (typeof device._createApi === 'function') device._createApi();
        }
      }
    };
    this.homey.settings.on('set', this._onAppSettingsChanged);

    this.log('GoogleHealthDriver has been initialized');
  }

  async onUninit() {
    if (this._onAppSettingsChanged) {
      this.homey.settings.removeListener('set', this._onAppSettingsChanged);
    }
  }

  getOAuthConfig() {
    return {
      clientId: this.homey.settings.get('client_id'),
      clientSecret: this.homey.settings.get('client_secret'),
      allowCardiac: !!this.homey.settings.get('enable_cardiac'),
    };
  }

  /**
   * Lazily create the Homey OAuth2 callback when the login view is shown, so
   * credentials saved in the app settings mid-session are picked up.
   * onCode receives the freshly exchanged token set.
   */
  _setupOAuthLogin(session, onCode, { closeSessionOnSuccess = false } = {}) {
    let started = false;

    session.setHandler('showView', async viewId => {
      if (viewId !== 'login_oauth2') return;

      const { clientId, clientSecret, allowCardiac } = this.getOAuthConfig();
      if (!clientId || !clientSecret) {
        await session.emit('error', this.homey.__('pair.missing_credentials'))
          .catch(this.error);
        return;
      }
      if (started) return;
      started = true;

      const authUrl = GoogleHealthApi.buildAuthUrl({
        clientId,
        scopes: GoogleHealthApi.scopes({ allowCardiac }),
      });

      const oauth2Callback = await this.homey.cloud.createOAuth2Callback(authUrl);
      oauth2Callback
        .on('url', url => {
          session.emit('url', url).catch(this.error);
        })
        .on('code', async code => {
          try {
            const tokens = await GoogleHealthApi.exchangeCode({ clientId, clientSecret, code });
            this.log('OAuth granted scopes:', tokens.scope || '(none reported)');
            await onCode({ tokens, clientId, clientSecret });
            // 'authorized' must be emitted BEFORE closing the session, or the
            // emit hits an already-destroyed PairSession (404)
            await session.emit('authorized');
            if (closeSessionOnSuccess) await session.done().catch(this.error);
          } catch (err) {
            this.error('OAuth flow failed:', err);
            // Reset the latch so re-opening the login view builds a fresh
            // callback and auth URL — otherwise a single failed exchange (e.g.
            // invalid_grant) leaves the login screen stuck for the whole session
            started = false;
            session.emit('error', err.message).catch(this.error);
          }
        });
    });
  }

  /** Fetch the user's identity id with a couple of retries. Returns null on failure. */
  async _fetchIdentityId(api) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const identity = await api.getIdentity();
        return {
          id: identity.obfuscatedId || identity.id || identity.email || null,
          name: identity.displayName || identity.email || null,
        };
      } catch (err) {
        this.error(`getIdentity attempt ${attempt} failed:`, err.message);
        if (attempt < 3) await new Promise(resolve => this.homey.setTimeout(resolve, 800));
      }
    }
    return null;
  }

  async onPair(session) {
    let auth = null;

    this._setupOAuthLogin(session, async result => {
      auth = result;
    });

    session.setHandler('list_devices', async () => {
      if (!auth) {
        throw new Error(this.homey.__('pair.not_authorized'));
      }

      const api = new GoogleHealthApi({
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        tokens: auth.tokens,
      });

      const identity = await this._fetchIdentityId(api);
      const identityId = identity ? identity.id : null;
      // Fall back to a random id only when the identity endpoint is
      // unavailable — the id must stay immutable once the device is created
      const deviceId = identityId || crypto.randomUUID();
      const deviceName = identity && identity.name
        ? `Google Health (${identity.name})`
        : 'Google Health';

      return [
        {
          name: deviceName,
          data: { id: String(deviceId) },
          store: {
            tokens: auth.tokens,
            identity_id: identityId ? String(identityId) : null,
          },
        },
      ];
    });
  }

  /**
   * Re-authorize an existing device. Verifies the login belongs to the same
   * Google account, so a household member cannot accidentally cross-wire
   * another person's health data onto this device.
   */
  async onRepair(session, device) {
    this._setupOAuthLogin(session, async ({ tokens, clientId, clientSecret }) => {
      const api = new GoogleHealthApi({ clientId, clientSecret, tokens });
      const identity = await this._fetchIdentityId(api);
      const newId = identity && identity.id ? String(identity.id) : null;
      const knownId = device.getStoreValue('identity_id')
        || (UUID_RE.test(device.getData().id) ? null : device.getData().id);

      // Fail closed: if this device is tied to a known account but we could not
      // confirm the new login's identity (identity endpoint unreachable), refuse
      // rather than risk cross-wiring a different person's account onto it
      if (knownId && !newId) {
        throw new Error(this.homey.__('pair.verify_failed'));
      }
      if (newId) {
        if (knownId && String(knownId) !== newId) {
          throw new Error(this.homey.__('pair.wrong_account'));
        }
        // Remember the identity for future repairs (covers UUID-fallback pairs)
        await device.setStoreValue('identity_id', newId).catch(this.error);
      }

      await device.onTokensRepaired(tokens);
    }, { closeSessionOnSuccess: true });
  }

}

module.exports = GoogleHealthDriver;
