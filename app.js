'use strict';

const Homey = require('homey');

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

    this.homey.flow.getActionCard('sync_now')
      .registerRunListener(async args => {
        await args.device.syncNow();
      });

    this.homey.flow.getActionCard('log_weight')
      .registerRunListener(async args => {
        await args.device.logWeight(args.weight);
      });

    this.log('Google Health app has been initialized');
  }

}

module.exports = GoogleHealthApp;
