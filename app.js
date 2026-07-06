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

    this.homey.flow.getConditionCard('exercised_today')
      .registerRunListener(async args => {
        const lastDate = args.device.getStoreValue('last_exercise_end_date');
        return !!lastDate && lastDate === args.device._todayLocalDate();
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

}

module.exports = GoogleHealthApp;
