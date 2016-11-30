'use strict';

const fingerprinter = require('fingerprinting');
const Cleancss = require('clean-css');

/**
 * Minify CSS, remove as much comments as possible.
 *
 * @param {Object} options Content (compiled CSS) and filepath.
 * @param {Function} done Completion callback.
 * @returns {void}
 * @api public
 */
module.exports = function cleancss(options, done) {
  new Cleancss({
    sourceMap: true,
    keepSpecialComments: 0
  }).minify(options.content, function minify(error, minified) {
    minified = minified || {};

    if (error) {
      return void done(error);
    }

    const fingerprint = fingerprinter(options.file, { content: minified.styles, map: true });
    // Adjust filename here
    const filename = options.file.replace('.css', '.min.css');
    const map = `${filename}.map`;

    return void done(null, {
      content: `${minified.styles}/*# sourceMappingURL=${map} */`,
      fingerprint: fingerprint.id,
      filename: filename
    }, {
      [map]: {
        content: minified.sourceMap.toString(),
        fingerprint: fingerprint.id
      }
    });
  });
};
