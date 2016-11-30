var path = require('path');
var webpack = require('webpack');
var CommonsChunkPlugin = webpack.optimize.CommonsChunkPlugin;

module.exports = {
  context: __dirname,
  entry: {
    preview: './preview.jsx',
    editor: './editor.jsx',
    publish: './publish.jsx'
  },
  externals: {
    'react': 'React'
  },
  module: {
    loaders: [{
      test: /\.jsx?$/,
      exclude: /(node_modules|bower_components)/,
      loader: 'babel'
    }]
  },
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].bundle.js',
    chunkFilename: '[id].chunk.js'
  },
  plugins: [
    new CommonsChunkPlugin('commons.js')
  ]
};
