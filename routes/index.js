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
				ip: server.ip,
				dead: server.dead
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

			var servers = app.get("servers");

			try {
				servers[req.params.id].socket.write(message.command);
			} catch(e) {}

			app.set("servers", servers);


			var messagesByServer = app.get("messagesByServer");

			messagesByServer[req.params.id].push(">"+message.command);

			app.set("messagesByServer", messagesByServer)

			var socketsByServer = app.get("socketsByServer");

			socketsByServer[req.params.id].filter(function(wsNew){
				if(wsNew == ws){
					return true;
				}

				try{
					wsNew.send(JSON.stringify({
						message: "data",
						data: ">"+message.command
					}));

					return true;
				}catch(e){
					return false;
				}
			});

			app.set("socketsByServer", socketsByServer);
		});
	});

	return router;
};
