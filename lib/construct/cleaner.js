const rmrf = require('./rmrf').async;

class Cleaner {
  constructor(options) {
    this.log = options.log;
  }

  async cleanup(paths) {
    paths = Array.isArray(paths) ? paths : [paths];
    const tasks = paths.map(async path => {
      this.log.info('Cleanup path: %s', path);
      await rmrf(path)
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
