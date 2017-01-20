var pm2 = require('pm2');

pm2.connect(function() {
	pm2.start({
		script: 'server.js'
	}, function(err) {
		if (err) return console.error('Error while launching applications', err.stack || err);
		console.log('PM2 and application has been succesfully started');
		
		// Display logs in standard output 
		pm2.launchBus(function(err, bus) {
			console.log('[PM2] Log streaming started');

			bus.on('log:out', function(packet) {
			 console.log('[App:%s] %s', packet.process.name, packet.data);
			});
				
			bus.on('log:err', function(packet) {
				console.error('[App:%s][Err] %s', packet.process.name, packet.data);
			});
		});
			
	});
});

