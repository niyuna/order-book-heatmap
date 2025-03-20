//const path = require('path');

module.exports =  () => ({
  entry: './src/index.js',
  target: 'web',
  mode: 'development',
  output: {
    //path: path.resolve(__dirname, 'dist'),
    path: '/home/ivo/isomorphic-ws/example/webpack/dist/',
    filename: 'main.js',
  },
});
