'use strict';

module.exports = {
  async getOverview({ homey, query }) {
    const metrics = String(query.metrics || '').split(',').filter(Boolean);
    return homey.app.getWidgetOverview(query.device, metrics);
  },
};
