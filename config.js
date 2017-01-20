const settings = {
	"PORT": 8080
};

module.exports = function(app){
	Object.keys(settings).forEach(function(key){
		try {
			app.set(key, JSON.parse(process.env[key]));
		} catch (e) {
			app.set(key, process.env[key] || settings[key]);
		}
	});
}
