const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const cactusRNPath = path.resolve(__dirname, '../cactus_framework/cactus-react-native');

const esc = (p) => p.replace(/[\\\/]/g, '[\\\\/]');

const config = {
  watchFolders: [cactusRNPath],
  resolver: {
    blockList: [
      new RegExp(esc(path.resolve(cactusRNPath, 'node_modules', 'react')) + '[\\\\/].*'),
      new RegExp(esc(path.resolve(cactusRNPath, 'node_modules', 'react-native')) + '[\\\\/].*'),
      new RegExp(esc(path.resolve(cactusRNPath, 'node_modules', 'react-native-nitro-modules')) + '[\\\\/].*'),
    ],
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
    ],
    extraNodeModules: {
      'react': path.resolve(__dirname, 'node_modules', 'react'),
      'react-native': path.resolve(__dirname, 'node_modules', 'react-native'),
      'react-native-nitro-modules': path.resolve(__dirname, 'node_modules', 'react-native-nitro-modules'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
