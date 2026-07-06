'use strict';

/**
 * App Web API — used by the settings page to build the printable health report.
 * Homey Pro only (declared platforms: ["local"]).
 */

module.exports = {

  async getDevices({ homey }) {
    const driver = homey.drivers.getDriver('google-health-user');
    return driver.getDevices().map(device => ({
      id: device.getData().id,
      name: device.getName(),
    }));
  },

  async getReport({ homey, query }) {
    const driver = homey.drivers.getDriver('google-health-user');
    const devices = driver.getDevices();
    if (!devices.length) {
      throw new Error(homey.__('pair.not_authorized'));
    }
    const device = devices.find(d => d.getData().id === query.device) || devices[0];
    return device.collectReport(Number(query.days) || 30);
  },

  async publishReport({ homey, body }) {
    return homey.app.publishReport(body && body.html);
  },

};
