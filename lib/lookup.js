/* eslint max-params: 0*/
const semver = require('semver');

/**
 * Lookup Object for parsing build heads
 * @public
 * @constructor
 * @param {Object} pkg - package object
 * @param {Object[]} heads - build heads for a given package in the fetched env
 */
function Lookup(pkg, heads) {
  this.pkg = pkg;
  this.heads = heads;
  this.latest = this.order(heads);
}

/**
 * Compute and order the heads to return the latest version
 * @private
 * @function order
 * @param {Object[]} heads - Array of head objects
 * @returns {String} latest version of the set
 */
Lookup.prototype.order = function order(heads) {
  return heads.filter(Boolean)
    .sort((a, b) => semver.compare(a.version, b.version))
    .reduce((latest, v) => {
      return semver.lt(latest, v.version) ? v.version : latest;
    }, '0.0.0');
};

/**
 * Compute objects to be sent over nsq for missing builds
 * @public
 * @function missing
 * @returns {Object[]} of spec objects to be sent to nsq
 */
Lookup.prototype.missing = function () {
  return this.heads.map(head => {
    return semver.lt(head.version, this.latest) && this.specify(head);
  }).filter(Boolean);
};

/**
 * Create a spec object given a head object and internal data
 * @private
 * @function specify
 * @param {Object} head - A given head object from a missing build
 * @returns {Spec} object to be sent to nsq
 */
Lookup.prototype.specify = function specify(head) {
  return new Spec(
    head.name,
    head.env,
    this.latest,
    head.locale,
    this.pkg.extended.build
  );
};

/**
 * Spec Object
 * @public
 * @constructor
 * @param {String} name - name of package
 * @param {String} env - env of package
 * @param {String} version - version of package
 * @param {String} locale - locale of package
 * @param {String} type - build type
 */
function Spec(name, env, version, locale, type) {
  this.name = name;
  this.env = env;
  this.version = version;
  this.locale = locale;
  this.type = type;
}

module.exports = Lookup;
module.exports.Spec = Spec;
