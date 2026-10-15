// Run after the production prune, before the release is sealed or deployed.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const name of ['braces', 'brace-expansion', 'browserslist', 'js-yaml', '@babel/core']) {
  try {
    require.resolve(name);
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') continue;
    throw error;
  }
  throw new Error(`Build dependency remains in the serving closure: ${name}`);
}
for (const name of ['next', 'react', 'react-dom', 'lucide-react']) require.resolve(name);
console.log('Production dependency closure verified');
