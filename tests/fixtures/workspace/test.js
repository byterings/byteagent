const assert = require('node:assert');
const { add, multiply } = require('./src/math');
assert.strictEqual(add(2, 3), 5);
assert.strictEqual(multiply(2, 3), 6);
console.log('2 tests passed');
