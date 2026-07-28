
var playerCompat = require('./player.compat.js');
var applyMovieCompatibility = playerCompat.applyMovieCompatibility;
var ensureProgression = require('../../shared/progression.js').ensureProgression;

function LadderClient(clientRef) {
	/* Point data to here */

	clientRef.newObject = this;

	/* References */
	this.sock = clientRef.sock;
    this.db = clientRef.db;
    this.WOPW = clientRef.WOPW;

	/* Connection details */
	this.newPacketHeader = "Originality is undetected plagiarism.\r\n\r\n";

	this.connectionType = clientRef.connectionType;
	this.initialized = false;

	/* Buffers and settings */
	this.tempBuffer = "";
	this.tempBufferLen = 0;
	this.awaitingData = false;
	this.dataParts = 0;

	/* Client data */
	this.id = clientRef.id;

	/* Player data */
	this.player = {};

	console.log(">> Initialized ladder client");
}

LadderClient.prototype = {

	// ### initialization functions ###
	setupPlayer : function(doc){
		this.player.id = doc.id;
		this.player.nw = doc.nw;
		this.player.level = doc.level;
		this.player.currentPet = doc.currentPet;
		this.player.login_streak = doc.login_streak;
		this.player.playerStatus = doc.playerStatus;
		this.player.status = doc.status;
		this.player.net = doc.net;
		this.player.snum = doc.serialNumber;
		this.player.gamecount = doc.gamecount;
		this.player.gold = doc.gold;
		this.player.treats = doc.treats;
		this.player.hp = doc.hp;
		this.player.wins = doc.wins;
		this.player.sesscount = doc.sesscount;
		this.player.losses = doc.losses;
		this.player.speed = doc.speed;
		this.player.attack = doc.attack;
		this.player.defence = doc.defence;
		this.player.jump = doc.jump;
		this.player.xp = doc.xp;
		this.player.userAccessories = doc.userAccessories;
		this.player.durability = doc.durability;
		this.player.ownedPets = doc.ownedPets;
		this.player.userWeaponsOwned = doc.userWeaponsOwned;
		this.player.unlimitedInventory = Boolean(doc.unlimitedInventory) || Object.values(doc.userWeaponsOwned || {}).some((count) => count >= 999999999);
		if(this.player.unlimitedInventory) this.player.userWeaponsOwned = Object.fromEntries(Object.keys(doc.userWeaponsOwned || {}).map((type) => [type, 99]));
		this.player.userWeaponsEquipped = doc.userWeaponsEquipped;
		this.player.allowedMaps = doc.allowedMaps;
		this.player.equippedFoods = doc.equippedFoods || {};
		this.player.cookingFoods = doc.cookingFoods || [];
		this.player.eatenFoods = doc.eatenFoods || [];
		this.player.statPoints = Number.isFinite(Number(doc.statPoints)) ? Number(doc.statPoints) : 50;
		this.player.combos = doc.combos && typeof doc.combos === "object" ? doc.combos : {};
		this.player.hotkeys = doc.hotkeys && typeof doc.hotkeys === "object" ? doc.hotkeys : {};
		this.player.sandbox = Boolean(doc.sandbox || doc.unlimitedInventory || Object.values(doc.userWeaponsOwned || {}).some((count) => count >= 999999999));
		this.player.unlimitedInventory = this.player.sandbox;
		this.player.stats = doc.stats || {};
		this.player.medals = doc.medals || {};
		this.player.membership = doc.membership || {};
		this.player.promos = doc.promos || {};
		this.player.mysteryGift = doc.mysteryGift || {};
		this.player.idleGift = doc.idleGift || {};
		this.player.weaponUnlocks = doc.weaponUnlocks || {};
		this.player.transactions = doc.transactions || {};
		this.player.dname = doc.dname;
		this.player.command = "setPlayer";
		this.player.online = this.WOPW.getLobbyLoad();
		ensureProgression(this.player);
		applyMovieCompatibility(this.player);
		console.log(">> " + this.player.dname  + " entered ladder");
	},

	// ### socket helpers ###
	sendPacket : function(packet){
		packet = JSON.stringify(packet);

		var len = Buffer.byteLength(packet, 'utf8');
		len = ("000000" + len).slice(-6);


		if(!this.initialized){
			this.initialized = true;
			packet = len + packet;
			packet = this.newPacketHeader + packet;
			this.write(packet);
			return;
		}

		packet = len + packet;
		this.write(packet);
	},

	write : function(str){
		if(!this.sock || !this.sock.writable) return;

		try{
			this.sock.write(str);
		}

		catch(e){
			console.log(e);
		}
	}
};

module.exports = LadderClient;
