const { add } = require('./math');

function greet(name) {
  return `Hello, ${name}! You have ${add(1, 2)} messages.`;
}

module.exports = { greet };
