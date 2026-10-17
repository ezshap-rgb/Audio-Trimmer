// Metro configuration for Lecture Recorder.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * @breezystack/lamejs declares:
 *   "main": "dist/lamejs.iife.js"
 * but that bundle assigns the encoder to a module-local variable and never sets
 * `module.exports`, so `require()` returns `{}` and `import { Mp3Encoder }`
 * silently resolves to undefined. Only its ESM build (`dist/lamejs.js`) has real
 * exports, and the package's `exports` map does not expose it under any
 * subpath, so resolving it by name is not possible either.
 *
 * Pin the bundler to the ESM file directly.
 */
const lamejsEsmBuild = path.resolve(
  __dirname,
  'node_modules/@breezystack/lamejs/dist/lamejs.js'
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@breezystack/lamejs') {
    return { filePath: lamejsEsmBuild, type: 'sourceFile' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
