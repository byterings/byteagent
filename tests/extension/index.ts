import Mocha from 'mocha';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Entry point called by the VS Code test host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 });
  for (const file of readdirSync(__dirname)) {
    if (file.endsWith('.test.js')) mocha.addFile(join(__dirname, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} extension test(s) failed`));
      else resolve();
    });
  });
}
