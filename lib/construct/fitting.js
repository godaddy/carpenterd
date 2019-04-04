'use strict';

/**
 * Extract the type of build we are doing
 * @param  {Object} config  wrhs config from publish payload
 * @param  {Object} options keywords to look for
 * @returns {String} type of build
 */
module.exports = function fitting(config, options) {
  options = options || {};

  //
  // Allow additional rules to be defined and merge against the default.
  //
  const classy = options.classification;
  const keyword = options.keyword || 'check';
  let match = '';

  //
  // The classification can also be read directly from the config.
  // Allow opt-in for a `keyword`. This defaults to the `check` property.
  //
  if (config[keyword] in classy) return config[keyword];

  //
  // Check if there are keywords in the package.json that gives some intel on
  // which project/team created these packages.
  //
  if (!Array.isArray(config.keywords)) config.keywords = [];

  Object.keys(classy).some(function each(project) {
    const keywords = classy[project];

    if (keywords.some(function some(keyword) {
      return !!~config.keywords.indexOf(keyword);
    })) return !!(match = project);

    return false;
  });

  return match;
};
