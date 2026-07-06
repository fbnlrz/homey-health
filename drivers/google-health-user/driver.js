'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const GoogleHealthApi = require('../../lib/GoogleHealthApi');

class GoogleHealthDriver extends Homey.Driver {

  async onInit() {
    // Device trigger cards, fired from device.js
    this.stepsUpdatedTrigger = this.homey.flow.getDeviceTriggerCard('steps_updated');
    this.stepGoalReachedTrigger = this.homey.flow.getDeviceTriggerCard('step_goal_reached');
    this.heartRateUpdatedTrigger = this.homey.flow.getDeviceTriggerCard('heart_rate_updated');
    this.newWeightTrigger = this.homey.flow.getDeviceTriggerCard('new_weight_measurement');
    this.sleepUpdatedTrigger = this.homey.flow.getDeviceTriggerCard('sleep_updated');

    this.log('GoogleHealthDriver has been initialized');
  }

  getOAuthConfig() {
    return {
      clientId: this.homey.settings.get('client_id'),
      clientSecret: this.homey.settings.get('client_secret'),
      allowWrite: !!this.homey.settings.get('enable_write'),
    };
  }

  async onPair(session) {
    let tokens = null;
    const { clientId, clientSecret, allowWrite } = this.getOAuthConfig();

    session.setHandler('showView', async viewId => {
      if (viewId === 'login_oauth2' && (!clientId || !clientSecret)) {
        await session.emit('error', this.homey.__('pair.missing_credentials'))
          .catch(this.error);
      }
    });

    if (clientId && clientSecret) {
      const authUrl = GoogleHealthApi.buildAuthUrl({
        clientId,
        scopes: GoogleHealthApi.scopes({ allowWrite }),
      });

      const oauth2Callback = await this.homey.cloud.createOAuth2Callback(authUrl);
      oauth2Callback
        .on('url', url => {
          session.emit('url', url).catch(this.error);
        })
        .on('code', async code => {
          try {
            tokens = await GoogleHealthApi.exchangeCode({ clientId, clientSecret, code });
            this.log('OAuth granted scopes:', tokens.scope || '(none reported)');
            await session.emit('authorized');
          } catch (err) {
            this.error('OAuth code exchange failed:', err);
            session.emit('error', err.message).catch(this.error);
          }
        });
    }

    session.setHandler('list_devices', async () => {
      if (!tokens) {
        throw new Error(this.homey.__('pair.not_authorized'));
      }

      const api = new GoogleHealthApi({ clientId, clientSecret, tokens });

      let deviceId = null;
      let deviceName = 'Google Health';
      try {
        const identity = await api.getIdentity();
        deviceId = identity.obfuscatedId || identity.id || identity.email || null;
        if (identity.displayName) deviceName = `Google Health (${identity.displayName})`;
        else if (identity.email) deviceName = `Google Health (${identity.email})`;
      } catch (err) {
        this.error('Could not fetch user identity, using generated id:', err.message);
      }
      if (!deviceId) deviceId = crypto.randomUUID();

      return [
        {
          name: deviceName,
          data: { id: String(deviceId) },
          store: { tokens },
        },
      ];
    });
  }

  /**
   * Re-authorize an existing device (e.g. after the refresh token expired).
   */
  async onRepair(session, device) {
    const { clientId, clientSecret, allowWrite } = this.getOAuthConfig();

    session.setHandler('showView', async viewId => {
      if (viewId === 'login_oauth2' && (!clientId || !clientSecret)) {
        await session.emit('error', this.homey.__('pair.missing_credentials'))
          .catch(this.error);
      }
    });

    if (clientId && clientSecret) {
      const authUrl = GoogleHealthApi.buildAuthUrl({
        clientId,
        scopes: GoogleHealthApi.scopes({ allowWrite }),
      });

      const oauth2Callback = await this.homey.cloud.createOAuth2Callback(authUrl);
      oauth2Callback
        .on('url', url => {
          session.emit('url', url).catch(this.error);
        })
        .on('code', async code => {
          try {
            const tokens = await GoogleHealthApi.exchangeCode({ clientId, clientSecret, code });
            this.log('OAuth granted scopes (repair):', tokens.scope || '(none reported)');
            await device.onTokensRepaired(tokens);
            await session.emit('authorized');
            await session.done();
          } catch (err) {
            this.error('OAuth repair failed:', err);
            session.emit('error', err.message).catch(this.error);
          }
        });
    }
  }

}

module.exports = GoogleHealthDriver;
