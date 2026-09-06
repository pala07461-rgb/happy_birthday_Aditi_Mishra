const requestHandler = require('../server.js');

module.exports = function handler(req, res) {
  return requestHandler(req, res);
};
