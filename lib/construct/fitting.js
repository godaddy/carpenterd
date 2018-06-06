'use strict';

//
// Extract the type of build we are doing
//
module.exports = function fitting(data, options) {
  options = options || {};

  //
  // Allow additional rules to be defined and merge against the default.
  //
  const classy = options.classification;
  const keyword = options.keyword || 'check';
  let match = '';

  //
  // The classification can also be read directly from the data.
  // Allow opt-in for a `keyword`. This defaults to the `check` property.
  //
  if (data[keyword] in classy) return data[keyword];

  //
  // Check if there are keywords in the package.json that gives some intel on
  // which project/team created these packages.
  //
  if (!Array.isArray(data.keywords)) data.keywords = [];

  Object.keys(classy).some(function each(project) {
    const keywords = classy[project];

    if (keywords.some(function some(keyword) {
      return !!~data.keywords.indexOf(keyword);
    })) return !!(match = project);

    return false;
  });

  return match;
};
