'use strict';

module.exports = {
  async getMetric({ homey, query }) {
    return homey.app.getWidgetMetric(query.device, query.metric);
  },
};
