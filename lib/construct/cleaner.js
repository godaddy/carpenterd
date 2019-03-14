const rmrf = require('./rmrf').async;

class Cleaner {
  constructor(options) {
    this.log = options.log;
  }

  /**
   * Clean up a given set of paths
   * @param  {Array[]} paths set of paths to be cleared
   * @returns {Promise} Completion handler
   */
  async cleanup(paths) {
    paths = Array.isArray(paths) ? paths : [paths];
    const tasks = paths.map(async path => {
      this.log.info('Cleanup path: %s', path);
      await rmrf(path);
    });
    try {
      await Promise.all(tasks);
    } catch (e) {
      return e;
    }

    return null;
  }
}

module.exports = Cleaner;
