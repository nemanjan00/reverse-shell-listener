// Styles

require('bootstrap/dist/css/bootstrap.min.css');
require('font-awesome/css/font-awesome.css');

require('jquery.terminal/css/jquery.terminal.css');

require('./style/dashboard.css');
require('./style/custom.css');

// jQuery, Bootstrap & Angular

window.jQuery = require('jquery');
window.$ = window.jQuery;

require('bootstrap');

require('angular');

require('jquery.mousewheel');
require('jquery.terminal');
require('angular-terminal');

require('angular-websocket');

// App

var app = angular.module('top.nemanja.reverse-shell-listener', ['angular-terminal', 'ngWebSocket']);

require("./controllers")(app);

window.resize = function() {
	$(".fluid").each(function(id, element){
		$(element).height($(window).height() - $(element).offset().top - 50);
	});
};

resize();

$(window).resize(resize);

