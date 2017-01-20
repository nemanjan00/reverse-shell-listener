module.exports = function(app) {
	var router = require('express').Router();

	var sockets = [];
	app.set("sockets", sockets);

	var socketsByServer = {};
	app.set("socketsByServer", socketsByServer);

	app.ws('/servers', function(ws, req) {
		app.get("servers").forEach(function(server){
			ws.send(JSON.stringify({
				message: "newServer",
				id: server.id,
				ip: server.ip
			}));
		});

		sockets.push(ws);
		app.set("sockets", sockets);
	});

	app.ws('/server/:id', function(ws, req) {
		var messagesByServer = app.get("messagesByServer");

		if(messagesByServer[req.params.id] == undefined){
			messagesByServer[req.params.id] = [];
		}

		app.set("messagesByServer", messagesByServer)

		messagesByServer[req.params.id].forEach(function(data){
			ws.send(JSON.stringify({
				message: "data",
				data: data+""
			}));
		});

		if(socketsByServer[req.params.id] == undefined){
			socketsByServer[req.params.id] = [];
		}

		socketsByServer[req.params.id].push(ws);
		app.set("socketsByServer", socketsByServer);

		ws.on("message", function(message){
			message = JSON.parse(message);

			var server = app.get("servers")[req.params.id];

			try {
				server.socket.write(message.command);
			} catch(e) {
				console.log(e);
			}
		});
	});

	return router;
};
