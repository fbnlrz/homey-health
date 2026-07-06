'use strict';

module.exports = {
  async getTiles({ homey, query }) {
    const ids = String(query.metrics || '').split(',').filter(Boolean);
    return homey.app.getWidgetTiles(query.device, ids);
  },
};
