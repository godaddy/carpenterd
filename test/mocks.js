exports.Writer = Writer;

function Writer() {}

Writer.prototype.publish = function (topic, payload, fn) {
  setImmediate(fn);
};
