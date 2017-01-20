module.exports = function(app){
	app.controller("MainController", function($scope, $timeout, $rootScope, $websocket){
		$scope.currentShell = {
			ip: "Not connected"
		};

		$scope.currentShellId = undefined;

		$scope.noneSelected = true;

		$scope.shells = {};

		$scope.haveShells = function(){
			return Object.keys($scope.shells).length != 0;
		}

		$scope.selectShell = function(id){
			$scope.currentShell = $scope.shells[id];
			$scope.currentShellId = id;

			$timeout(function(){
				window.resize();
			}, 0);
		}

		$scope.shellSelected = function(){
			return $scope.currentShellId != undefined;
		}

		$rootScope.$on('terminal.main', function (e, input, terminal) {
			$rootScope.$emit('terminal.main.echo', input);
		});

		connection = $websocket(window.location.href.replace("http", "ws")+"servers");

		connection.onMessage(function(message) {
			message = JSON.parse(message.data);

			if(message.message == "newServer"){
				$scope.shells[message.id] = {
					ip: message.ip
				};

				var newConnection = $websocket(window.location.href.replace("http", "ws")+"server/"+message.id);

				var id = message.id;

				newConnection.onMessage(function(message){
					message = JSON.parse(message.data);
					$rootScope.$emit('terminal.main-'+id+'.echo', message.data.trim());
				});

				$rootScope.$on('terminal.main-'+id, function (e, input, terminal) {
					newConnection.send(JSON.stringify({
						message: "command", 
						command: input+"\n"
					}));
				});
			}
		});
		
		$timeout(function(){
			window.resize();
		}, 0);
	});
}
