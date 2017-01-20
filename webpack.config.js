var LiveReloadPlugin = require('webpack-livereload-plugin');

module.exports = {
	entry: "./entry.js",
	output: {
		path: __dirname+"/public/assets",
		publicPath: "assets/",
		filename: "bundle.js"
	},
	module: {
		loaders: [
			{
				test: /\.css$/,
				loader: "style-loader!css-loader"
			},
			{
				test : /\.(png|ttf|eot|svg|woff(2)?)(\?[a-z0-9=&.]+)?$/,
				loader : 'file-loader'
			}
		]
	},
	plugins: [
		new LiveReloadPlugin({appendScriptTag: true})
	],
	node: {
		fs: 'empty',
		tls: 'empty'
	},
	target: 'web'
};

