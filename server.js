// Express init

var express = require('express');

var app = express();
var expressWs = require('express-ws')(app);

var config = require('./config')(app);

// Routing

app.use(express.static('public'));

app.use('/', require('./routes')(app));

// Start

app.listen(app.get('PORT'), function () {
	console.log('PPS app listening on port '+app.get('PORT')+'!');
});

var net = require('net');

var id = 0;

var servers = [];
app.set("servers", servers);

var messagesByServer = {};
app.set("messagesByServer", messagesByServer);

var server = net.createServer(function(socket) {
	var currentId = id+"";
	var currentIP = socket.address().address+"";

	socket.on("data", function(data){
		if(messagesByServer[currentId] == undefined){
			messagesByServer[currentId] = [];
		}

		messagesByServer[currentId].push(data);

		app.set("messagesByServer", messagesByServer);

		var socketsByServer = app.get("socketsByServer");

		if(socketsByServer[currentId] == undefined){
			socketsByServer[currentId] = [];
		}

		socketsByServer[currentId].filter(function(ws){
			try{
				ws.send(JSON.stringify({
					message: "data",
					data: data+""
				}));

				return true;
			}catch(e){
				return false;
			}
		});

		app.set("socketsByServer", socketsByServer);
	});

	socket.on("error", function(data){
		if(messagesByServer[currentId] == undefined){
			messagesByServer[currentId] = [];
		}

		messagesByServer[currentId].push("connection closed");

		app.set("messagesByServer", messagesByServer);

		var socketsByServer = app.get("socketsByServer");

		if(socketsByServer[currentId] == undefined){
			socketsByServer[currentId] = [];
		}

		socketsByServer[currentId].filter(function(ws){
			try{
				ws.send(JSON.stringify({
					message: "data",
					data: "connection closed"
				}));

				return true;
			}catch(e){
				return false;
			}
		});

		app.set("socketsByServer", socketsByServer);

		var servers = app.get("servers");

		servers[currentId].dead = true;


		var sockets = app.get("sockets");

		sockets.filter(function(ws){
			try{
				ws.send(JSON.stringify({
					message: "newServer",
					id: currentId,
					ip: currentIP,
					dead: true
				}));

				return true;
			}catch(e){
				return false;
			}
		});

		app.set("sockets", sockets);
	});

	servers.push({
		socket: socket,
		id: id,
		ip: socket.address().address,
		dead: false
	});

	app.set("servers", servers);

	var sockets = app.get("sockets");

	sockets.filter(function(ws){
		try{
			ws.send(JSON.stringify({
				message: "newServer",
				id: id,
				ip: socket.address().address,
				dead: false
			}));

			return true;
		}catch(e){
			return false;
		}
	});

	app.set("sockets", sockets);

	id++;
});

server.listen(1337, '0.0.0.0');

